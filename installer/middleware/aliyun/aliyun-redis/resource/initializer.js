'use strict';

const readFileSync = require('fs').readFileSync;
const watchFile = require('fs').watchFile;
const yaml = require('js-yaml');
const redis = require('@alicloud/r-kvstore20150101');
const Config = require('@alicloud/openapi-client').Config;
const RuntimeOptions = require('@alicloud/tea-util').RuntimeOptions;

let lastModify = 0;
let lastStartInit = -1;
let initialing = false;

// const configFilePath = '/aliyun/kafka/initializer.yaml'
const configFilePath = `${__dirname}/initializer.yaml`;

const init = async () => {
  initialing = true;
  lastStartInit = new Date();
  const result = {
    'date-time': '',
    err: null,
    messages: [],
  };
  const initConfig = yaml.load(readFileSync(configFilePath, 'utf8'));

  const clientConfig = new Config({
    accessKeyId: process.env['ALIBABA_CLOUD_ACCESS_KEY_ID'],
    accessKeySecret: process.env['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
  });
  clientConfig.endpoint = `${initConfig.product}-vpc.${initConfig.region}.aliyuncs.com`;
  const apiClient = new redis.default(clientConfig);
  const runtime = new RuntimeOptions({
    autoretry: true,
    maxAttempts: 10,
    readTimeout: 60000,
    connectTimeout: 60000,
  });

  //====================================================================================================================
  // 请求构造
  //====================================================================================================================
  const getInstanceRequest = (instanceName) => new redis.DescribeInstancesRequest({
    regionId: initConfig.region,
    tag: [{ key: 'delegate', value: 'true' }, { key: 'uname', value: instanceName }]
      .map(tag => new redis.DescribeInstancesRequestTag(tag)),
  });

  const getAccountsRequest = (instanceId) => new redis.DescribeAccountsRequest({
    instanceId,
  });

  const describeAccountRequests = (action, instance, accounts) => accounts.map(account => {
    const desc = JSON.parse(account.accountDescription);
    if (action === 'removing') {
      Object.assign(desc, { removing: 'true' });
    }
    return {
      name: account.accountName,
      request: new redis.ModifyAccountDescriptionRequest({
        instanceId: instance.id,
        accountName: account.accountName,
        accountDescription: JSON.stringify(desc),
      }),
    };
  });

  const resetAccountPasswordRequests = (instance, accounts) => accounts.map(account => ({
    name: account.accountName,
    request: new redis.ResetAccountPasswordRequest({
      instanceId: instance.id,
      accountName: account.accountName,
      accountPassword: account.accountName + initConfig.instances[instance.name][account.accountName].account.password,
    }),
  }));

  const createAccountRequests = (instance, accounts) => accounts.map(account => ({
    name: account.name,
    request: new redis.CreateAccountRequest({
      instanceId: instance.id,
      accountName: account.name,
      accountPassword: account.password,
      accountPrivilege: 'RoleReadWrite',
      accountType: 'Normal',
      accountDescription: `{"delegate": "true", "domain": "${account.name}", "instance": "${instance.name}"}`,
    }),
  }));

  //====================================================================================================================
  // 逻辑执行
  //====================================================================================================================
  const getInstance = async (instanceName) => {
    const instanceResp = await apiClient.describeInstancesWithOptions(getInstanceRequest(instanceName), runtime);
    if (instanceResp.statusCode !== 200) {
      throw new Error(`obtain instance for name: ${instanceName} failure.`);
    }
    if (instanceResp.body.instances.KVStoreInstance.length !== 1) {
      throw new Error(`un-excepted count of instances for name: '${instanceName}'.`);
    }
    if (instanceResp.body.instances.KVStoreInstance[0].instanceStatus !== 'Normal') {
      throw new Error(`un-excepted status of instances for name: '${instanceName}'.`);
    }
    return instanceResp.body.instances.KVStoreInstance[0];
  };

  const getAccounts = async (instance) => {
    const accountsResp = await apiClient.describeAccountsWithOptions(getAccountsRequest(instance.id), runtime);
    if (accountsResp.statusCode !== 200) {
      throw new Error(`obtain accounts for instance: '${instance.name}' failure.`);
    }

    return {
      accounts: (accountsResp.body.accounts?.account || [])
        .filter(account => {
          try {
            return JSON.parse(account.accountDescription)?.delegate === 'true'
          } catch (_error) {
            return false;
          }
        }),
    };
  };

  const describeRemovingAccounts = async (message, instance, accounts) => {
    for (let {name, request} of describeAccountRequests('removing', instance, accounts)) {
      try {
        const resp = await apiClient.modifyAccountDescriptionWithOptions(request, runtime);
        if (resp.statusCode === 200) {
          message.accounts[name] = `removing account for instance '${instance.name}' successful.`;
        } else {
          message.accounts[name] = `removing account for instance '${instance.name}' failure.`;
        }
      } catch (error) {
        message.accounts[name] = `removing account for instance '${instance.name}' failure.`
          + `\n${error.data?.Recommend || ''}`;
      }
    }
  };

  const updateAccounts = async (message, instance, accounts) => {
    for (let {name, request} of resetAccountPasswordRequests(instance, accounts)) {
      try {
        const resp = await apiClient.resetAccountPasswordWithOptions(request, runtime);
        if (resp.statusCode === 200) {
          message.accounts[name] = `reset account password for instance: '${instance.name}' successful.`;
        } else {
          message.accounts[name] = `reset account password for instance: '${instance.name}' failure.`;
        }
      } catch (error) {
        message.accounts[name] = `reset account password for instance: '${instance.name}' failure: ${error.message}`
          + `\n${error.data?.Recommend || ''}`;
      }
    }
  };

  const addAccounts = async (message, instance, accounts) => {
    for (let {name, request} of createAccountRequests(instance, accounts)) {
      try {
        const resp = await apiClient.createAccountWithOptions(request, runtime);
        if (resp.statusCode === 200) {
          message.accounts[name] = `add account for instance: '${instance.name}' successful.`;
        } else {
          message.accounts[name] = `add account for instance: '${instance.name}' failure.`;
        }
      } catch (error) {
        message.accounts[name] = `add account for instance: '${instance.name}' failure: ${error.message}`
          + `\n${error.data?.Recommend || ''}`;
      }
    }
  };

  //====================================================================================================================
  // 流程控制
  //====================================================================================================================
  const checkInstance = async (instanceName) => {
    try {
      const instance = await getInstance(instanceName);
      return {
        id: instance.instanceId,
        name: instanceName,
        endpoint: `${instance.connectionDomain}:${instance.port.toString()}`,
        data: instance,
      };
    } catch (error) {
      result.messages.push({
        id: '-',
        name: instanceName,
        endpoint: '-',
        message: `check instance failure. Cause: ${error.message}`
          + `\n${error.data?.Recommend || ''}`,
      })
      return null;
    }
  };

  const obtainAccounts = async (instance) => {
    try {
      return await getAccounts(instance);
    } catch (error) {
      result.messages.push({
        id: instance.id,
        name: instance.name,
        message: `obtain accounts failure. Cause: ${error.message}`
          + `\n${error.data?.Recommend || ''}`,
      })
      return null;
    }
  };

  const removeAccounts = async (instance, resources, existResources) => {
    const message = {
      accounts: {},
    };
    const removingAccounts = existResources.accounts
      .filter(account => !resources.accounts.map(a => a.name).includes(account.accountName))
      .filter(account => !(JSON.parse(account.accountDescription)?.removing === 'true'));
      await describeRemovingAccounts(
        message,
        instance,
        removingAccounts,
      );
    result.messages.push({
      id: instance.id,
      name: instance.name,
      endpoint: instance.endpoint,
      action: 'removing',
      message,
    });
  };

  const modifyAccounts = async (instance, resources, existResources) => {
    const message = {
      accounts: {},
    };
    const modifyingAccounts = existResources.accounts
      .filter(account => resources.accounts.map(a => a.name).includes(account.accountName))
      .filter(account => {
        const accounts = resources.accounts.filter(a => a.name === account.accountName);
        if (accounts.length !== 1) {
          message.accounts[account.accountName] = `unable to modify account: '${account.accountName}', same account in configuration.`;
          return false;
        }
        return true;
      });
      await updateAccounts(message, instance, modifyingAccounts);
    result.messages.push({
      id: instance.id,
      name: instance.name,
      endpoint: instance.endpoint,
      action: 'modify',
      message,
    });
  };

  const createAccounts = async (instance, resources, existResources) => {
    const message = {
      accounts: {},
    };
    const creatingAccounts = resources.accounts.filter(account => !existResources.accounts.map(a => a.accountName).includes(account.name));
    await addAccounts(message, instance, creatingAccounts);
    result.messages.push({
      id: instance.id,
      name: instance.name,
      endpoint: instance.endpoint,
      action: 'create',
      message,
    });
  };

  try {
    for (let instanceName of Object.keys(initConfig.instances)) {
      const instance = await checkInstance(instanceName);
      if (instance) {
        const resources = Object.keys(initConfig.instances[instanceName])
          .reduce((pre, curr) => ({
            accounts: pre.accounts.concat([{
              name: curr,
              password: curr + initConfig.instances[instanceName][curr].account.password,
            }]),
          }), { accounts: [] });
        const existResources = await obtainAccounts(instance);
        if (existResources) {
          await removeAccounts(instance, resources, existResources);
          await modifyAccounts(instance, resources, existResources);
          await createAccounts(instance, resources, existResources);
        }
      }
    }
  } catch (error) {
    result.err = error.toString();
  } finally {
    initialing = false;
    result['date-time'] = new Date().toISOString();
    console.info(JSON.stringify(result, null, 2));
  }
}

watchFile(configFilePath, () => {
  lastModify = new Date();
});

setInterval(() => {
  if (!initialing && lastModify >= lastStartInit) { // 没有正在执行，且配置最后修改时间大于最后一个开始执行时间
    init();
  }
}, 5000);
