'use strict';

const readFileSync = require('fs').readFileSync;
const watchFile = require('fs').watchFile;
const yaml = require('js-yaml');
const polardb = require('@alicloud/polardb20170801');
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
  const apiClient = new polardb.default(clientConfig);
  const runtime = new RuntimeOptions({
    autoretry: true,
    maxAttempts: 10,
    readTimeout: 60000,
    connectTimeout: 60000,
  });

  //====================================================================================================================
  // 请求构造
  //====================================================================================================================
  const getInstanceRequest = (instanceName) => new polardb.DescribeDBClustersRequest({
    regionId: initConfig.region,
    tag: [{ key: 'delegate', value: 'true' }, { key: 'uname', value: instanceName }]
      .map(tag => new polardb.DescribeDBClustersRequestTag(tag)),
  });

  const getInstanceEndpointRequest = (id) => new polardb.DescribeDBClusterEndpointsRequest({
    DBClusterId: id,
  });

  const getAccountListRequest = (instanceId) => new polardb.DescribeAccountsRequest({
    DBClusterId: instanceId,
    pageSize: 100,
  });

  const getDatabaseListRequest = (instanceId) => new polardb.DescribeDatabasesRequest({
    DBClusterId: instanceId,
    pageSize: 100,
  });

  const describeAccountRequests = (action, instance, accounts) => accounts.map(account => {
    const desc = JSON.parse(account.accountDescription);
    if (action === 'removing') {
      Object.assign(desc, { removing: 'true' });
    }
    return {
      name: account.accountName,
      request: new polardb.ModifyAccountDescriptionRequest({
        DBClusterId: instance.id,
        accountName: account.accountName,
        accountDescription: JSON.stringify(desc),
      }),
    };
  });

  const describeDatabaseRequests = (action, instance, databases) => databases.map(database => {
    const desc = JSON.parse(database.DBDescription);
    if (action === 'removing') {
      Object.assign(desc, { removing: 'true' });
    }
    if (action === 'domain') {
      Object.assign(desc, { domain: database.domain })
    }
    return {
      name: database.DBName,
      request: new polardb.ModifyDBDescriptionRequest({
        DBClusterId: instance.id,
        DBName: database.DBName,
        DBDescription: JSON.stringify(desc),
      }),
    };
  });

  const grantAccountPrivilegeRequests = (instance, databases, accounts) => accounts.map(account => {
    const grantDatabases = databases.filter(
      database => database.domain === account.accountName,
    ).map(database => database.DBName);
    if (grantDatabases.length === 0) {
      return {};
    }
    return {
      name: account.accountName,
      request: new polardb.GrantAccountPrivilegeRequest({
        DBClusterId: instance.id,
        accountName: account.accountName,
        DBName: grantDatabases.join(','),
        accountPrivilege: grantDatabases.map(_ => 'ReadWrite').join(','),
      }),
    };
  });

  const revokeAccountPrivilegeRequests = (instance, accounts) => accounts.map(account => ({
    name: account.accountName,
    request: new polardb.RevokeAccountPrivilegeRequest({
      DBClusterId: instance.id,
      accountName: account.accountName,
      DBName: account.databasePrivileges.map(d => d.DBName).join(','),
    }),
  }));

  const modifyAccountPasswordRequest = (instance, accounts) => accounts.map(account => ({
    name: account.accountName,
    request: new polardb.ModifyAccountPasswordRequest({
      DBClusterId: instance.id,
      accountName: account.accountName,
      newAccountPassword: account.accountName + initConfig.instances[instance.name][account.accountName].account.password,
    }),
  }));

  const createAccountRequests = (instance, accounts) => accounts.map(account => ({
    name: account.name,
    request: new polardb.CreateAccountRequest({
      DBClusterId: instance.id,
      accountName: account.name,
      accountPassword: account.password,
      accountType: 'Normal',
      accountDescription: `{"delegate": "true", "domain": "${account.name}", "instance": "${instance.name}"}`
    }),
  }));

  const createDatabaseRequests = (instance, databases) => databases.map(database => ({
    name: database.name,
    request: new polardb.CreateDatabaseRequest({
      DBClusterId: instance.id,
      DBName: database.name,
      DBDescription: `{"delegate": "true", "domain": "${database.domain}", "instance": "${instance.name}"}`,
      accountName: database.domain,
      ...initConfig.default.database,
    }),
  }));

  //====================================================================================================================
  // 逻辑执行
  //====================================================================================================================
  const getInstance = async (instanceName) => {
    const instanceResp = await apiClient.describeDBClustersWithOptions(getInstanceRequest(instanceName), runtime);
    if (instanceResp.statusCode !== 200) {
      throw new Error(`obtain instance for name: '${instanceName}' failure.`);
    }
    if (instanceResp.body.items.DBCluster.length !== 1) {
      throw new Error(`un-excepted count of instances for name: '${instanceName}'.`);
    }
    if (instanceResp.body.items.DBCluster[0].DBClusterStatus !== 'Running') {
      throw new Error(`un-excepted status of instances for name: '${instanceName}'.`);
    }
    return instanceResp.body.items.DBCluster[0];
  };

  const getAccountsAndDatabases = async (instance) => {
    const accountsResp = await apiClient.describeAccountsWithOptions(getAccountListRequest(instance.id), runtime);
    if (accountsResp.statusCode !== 200) {
      throw new Error(`obtain accounts for instance: '${instance.name}' failure.`);
    }

    const databasesResp = await apiClient.describeDatabasesWithOptions(getDatabaseListRequest(instance.id), runtime);
    if (databasesResp.statusCode !== 200) {
      throw new Error(`obtain databases for instance: '${instance.name}' failure.`);
    }

    return {
      accounts: (accountsResp.body.accounts || [])
        .filter(account => {
          try {
            return JSON.parse(account.accountDescription)?.delegate === 'true'
          } catch (_error) {
            return false;
          }
        }),
      databases: (databasesResp.body.databases.database || [])
        .filter(database => {
          try {
            return JSON.parse(database.DBDescription)?.delegate === 'true'
          } catch (_error) {
            return false;
          }
        }),
    };
  };

  const describeRemovingAccountsAndDatabases = async (message, instance, accounts, databases) => {
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
    for (let {name, request} of describeDatabaseRequests('removing', instance, databases)) {
      try {
        const resp = await apiClient.modifyDBDescriptionWithOptions(request, runtime);
        if (resp.statusCode === 200) {
          message.databases[name] = `removing database for instance '${instance.name}' successful.`;
        } else {
          message.databases[name] = `removing database for instance '${instance.name}' failure.`;
        }
      } catch (error) {
        message.databases[name] = `removing database for instance '${instance.name}' failure.`
          + `\n${error.data?.Recommend || ''}`;
      }
    }
  };

  const updateAccountsAndDatabases = async (message, instance, resources, accounts, databases) => {
    const dbs = databases.map(database => ({
      ...database,
      domain: resources.databases.filter(d => d.name === database.DBName)[0].domain,
    }));
    for (let {name, request} of describeDatabaseRequests('domain', instance, dbs)) {
      try {
        const resp = await apiClient.modifyDBDescriptionWithOptions(request, runtime);
        if (resp.statusCode === 200) {
          message.databases[name] = `update database description for instance: '${instance.name}' successful.`;
        } else {
          message.databases[name] = `update database description for instance: '${instance.name}' failure.`;
        }
      } catch (error) {
        message.databases[name] = `update database description for instance: '${instance.name}' failure: ${error.message}`
          + `\n${error.data?.Recommend || ''}`;
      }
    }
    for (let {name, request} of modifyAccountPasswordRequest(instance, accounts)) {
      try {
        const resp = await apiClient.modifyAccountPasswordWithOptions(request, runtime);
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
    for (let {name, request} of revokeAccountPrivilegeRequests(instance, accounts)) {
      try {
        const resp = await apiClient.revokeAccountPrivilegeWithOptions(request, runtime);
        if (resp.statusCode === 200) {
          message.accounts[name] = `revoke account privilege for instance: '${instance.name}' successful.`;
        } else {
          message.accounts[name] = `revoke account privilege for instance: '${instance.name}' failure.`;
        }
      } catch (error) {
        message.accounts[name] = `revoke account privilege for instance: '${instance.name}' failure: ${error.message}`
          + `\n${error.data?.Recommend || ''}`;
      }
    }
    for (let {name, request} of grantAccountPrivilegeRequests(instance, dbs, accounts)) {
      try {
        if (request) {
          const resp = await apiClient.grantAccountPrivilegeWithOptions(request, runtime);
          if (resp.statusCode === 200) {
            message.accounts[name] = `grant account privilege for instance: '${instance.name}' successful.`;
          } else {
            message.accounts[name] = `grant account privilege for instance: '${instance.name}' failure.`;
          }
        }
      } catch (error) {
        message.accounts[name] = `grant account privilege for instance: '${instance.name}' failure: ${error.message}`
          + `\n${error.data?.Recommend || ''}`;
      }
    }
  };

  const addAccountsAndDatabases = async (message, instance, accounts, databases) => {
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
    for (let {name, request} of createDatabaseRequests(instance, databases)) {
      try {
        const resp = await apiClient.createDatabaseWithOptions(request, runtime);
        if (resp.statusCode === 200) {
          message.databases[name] = `add database for instance: '${instance.name}' successful.`;
        } else {
          message.databases[name] = `add database for instance: '${instance.name}' failure.`;
        }
      } catch (error) {
        message.databases[name] = `add database for instance: '${instance.name}' failure: ${error.message}`
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
      const resp = await apiClient.describeDBClusterEndpointsWithOptions(getInstanceEndpointRequest(instance.DBClusterId), runtime);
      let endpoint = '';
      if (resp.statusCode === 200) {
        const addressItem = resp.body.items.filter(endpoint => endpoint.endpointType === 'Cluster')[0].addressItems[0]
        endpoint = `${addressItem.connectionString}:${addressItem.port.toString()}`
      }
      return {
        id: instance.DBClusterId,
        name: instanceName,
        endpoint,
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

  const obtainAccountsAndDatabases = async (instance) => {
    try {
      return await getAccountsAndDatabases(instance);
    } catch (error) {
      result.messages.push({
        id: instance.id,
        name: instance.name,
        message: `obtain accounts and databases failure. Cause: ${error.message}`
          + `\n${error.data?.Recommend || ''}`,
      })
      return null;
    }
  };

  const removeAccountsAndDatabases = async (instance, resources, existResources) => {
    const message = {
      accounts: {},
      databases: {},
    };
    const removingAccounts = existResources.accounts
      .filter(account => !resources.accounts.map(a => a.name).includes(account.accountName))
      .filter(account => !(JSON.parse(account.accountDescription)?.removing === 'true'));
    const removingDatabases = existResources.databases
      .filter(database => !resources.databases.map(d => d.name).includes(database.DBName))
      .filter(database => !(JSON.parse(database.DBDescription)?.remove === 'true'));
    await describeRemovingAccountsAndDatabases(
      message,
      instance,
      removingAccounts,
      removingDatabases
    );
    result.messages.push({
      id: instance.id,
      name: instance.name,
      endpoint: instance.endpoint,
      action: 'removing',
      message,
    });
  };

  const modifyAccountsAndDatabases = async (instance, resources, existResources) => {
    const message = {
      accounts: {},
      databases: {},
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
    const modifyingDatabases = existResources.databases
      .filter(database => resources.databases.map(d => d.name).includes(database.DBName))
      .filter(database => {
        const databases = resources.databases.filter(d => d.name === database.DBName);
        if (databases.length !== 1) {
          message.databases[database.DBName] = `unable to modify database: '${database.DBName}', same database in configuration.`;
          return false;
        }
        return true;
      });
    await updateAccountsAndDatabases(message, instance, resources, modifyingAccounts, modifyingDatabases);
    result.messages.push({
      id: instance.id,
      name: instance.name,
      endpoint: instance.endpoint,
      action: 'modify',
      message,
    });
  };

  const createAccountsAndDatabases = async (instance, resources, existResources) => {
    const message = {
      accounts: {},
      databases: {},
    };
    const creatingAccounts = resources.accounts.filter(account => !existResources.accounts.map(a => a.accountName).includes(account.name));
    const creatingDatabases = resources.databases.filter(database => !existResources.databases.map(d => d.DBName).includes(database.name));
    await addAccountsAndDatabases(message, instance, creatingAccounts, creatingDatabases);
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
            databases: pre.databases.concat(initConfig.instances[instanceName][curr].databases.map(database => ({
              ...database,
              domain: curr,
              account: curr,
            }))),
          }), { accounts: [], databases: [] });
        const existResources = await obtainAccountsAndDatabases(instance);
        if (existResources) {
          await removeAccountsAndDatabases(instance, resources, existResources);
          await modifyAccountsAndDatabases(instance, resources, existResources);
          await createAccountsAndDatabases(instance, resources, existResources);
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
