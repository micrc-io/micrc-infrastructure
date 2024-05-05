'use strict';

const execSync = require('child_process').execSync;
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
    err: '',
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
  const getInstanceRequest = (tags, ids = []) => new polardb.DescribeDBClustersRequest({
    regionId: initConfig.region,
    DBClusterIds: ids.join(','),
    tag: tags.concat({ key: 'delegate', value: 'true' }).map(tag => new polardb.DescribeDBClustersRequestTag(tag)),
    pageSize: 100,
  });

  const getAllInstanceRequest = (tags, ids = []) => new polardb.DescribeDBClustersRequest({
    regionId: initConfig.region,
    DBClusterIds: ids.join(','),
    tag: tags.map(tag => new polardb.DescribeDBClustersRequestTag(tag)),
    pageSize: 100,
  });

  const getInstanceServerlessRequest = (id) => new polardb.DescribeDBClusterServerlessConfRequest({
    DBClusterId: id,
  });

  const getInstanceEndpointRequest = (id) => new polardb.DescribeDBClusterEndpointsRequest({
    DBClusterId: id,
  });

  const tagInstanceRequests = (tags, instances) => instances.map(instance => ({
    name: instance.name,
    request: new polardb.TagResourcesRequest({
      regionId: initConfig.region,
      resourceType: 'cluster',
      resourceId: [instance.id],
      tag: tags.concat([{ key: 'delegate', value: 'true' }, { key: 'uname', value: instance.name }])
        .map(tag => new polardb.TagResourcesRequestTag(tag)),
    }),
  }));

  const updateInstanceServerlessRequests = (instances) => instances.map(instance => ({
    id: instance.id,
    name: instance.name,
    request: new polardb.ModifyDBClusterServerlessConfRequest({
      DBClusterId: instance.id,
      ...initConfig.instances[instance.name],
      ...Object.keys(initConfig.instances[instance.name].config).reduce((prev, curr) => ({
        ...prev,
        [curr]: initConfig.instances[instance.name].config[curr].toString(),
      }), {}),
    }),
  }));

  const updateAllowedIpRequests = (instances, ips = []) => instances.map(instance => ({
    id: instance.id,
    name: instance.name,
    request: new polardb.ModifyDBClusterAccessWhitelistRequest({
      DBClusterId: instance.id,
      securityIps: ips.join(','),
      ...initConfig.default.whitelist,
    }),
  }));

  const resetAccountRequests = (instances) => instances.map(instance => ({
    id: instance.id,
    name: instance.name,
    request: new polardb.ResetAccountRequest({
      DBClusterId: instance.id,
      accountName: instance.name,
      accountPassword: initConfig.instances[instance.name].account.password,
    }),
  }));

  const getAccountRequest = (instanceId, accountName) => new polardb.DescribeAccountsRequest({
    DBClusterId: instanceId,
    accountName,
  });

  const createInstanceRequests = (instances) => instances.map(instance => ({
    name: instance.name,
    request: new polardb.CreateDBClusterRequest({
      regionId: initConfig.region,
      zoneId: initConfig.zone,
      DBClusterDescription: instance.name,
      resourceGroupId: initConfig.resourceGroupId,
      VPCId: initConfig.vpc.id,
      vSwitchId: initConfig.vpc.vSwitchIds[0],
      securityIPList: initConfig.vpc.clusterIps.join(','),
      ...Object.keys(instance.config.serverless).reduce((prev, curr) => ({
        ...prev,
        [curr]: instance.config.serverless[curr].toString(),
      }), {}),
      ...initConfig.default.create,
    }),
  }));

  const createAccountRequests = (instances) => instances.map(instance => ({
    name: instance.name,
    request: new polardb.CreateAccountRequest({
      DBClusterId: instance.id,
      accountName: instance.name,
      accountPassword: initConfig.instances[instance.name].account.password,
    }),
  }));

  //====================================================================================================================
  // 工具函数
  //====================================================================================================================
  const _updateValidateFilter = (message, modifyingInstances) => modifyingInstances.filter(instance => {
    message[instance.name] = {};
    let checked = true;
    const config = initConfig.instances[instance.name].config;
    const spec = initConfig.spec;
    if (config.scaleMin < spec.scale.min || config.scaleMax > spec.scale.max) { // 校验规格扩缩容配置
      message[instance.name]['check-scale'] = `Illegal value of scale.`;
      checked = false;
    }
    if (config.scaleRoNumMin < spec.scaleRoNum.min || config.scaleRoNumMax > spec.scaleRoNum.max) { // 校验只读节点扩缩容配置
      message[instance.name]['check-scale-ro-num'] = `Illegal value of scale-ro-num.`;
      checked = false;
    }
    if (config.scaleMin.toString() === instance.config.serverless.scaleMin
      && config.scaleMax.toString() === instance.config.serverless.scaleMax
      && config.scaleRoNumMin.toString() === instance.config.serverless.scaleRoNumMin
      && config.scaleRoNumMax.toString() === instance.config.serverless.scaleRoNumMax
    ) {
      message[instance.name]['check-config'] = `update ignore, because of same configuration.`;
      checked = false;
    }
    return checked;
  });;

  const _createValidateFilter = (message, creatingInstances) => creatingInstances.filter(instance => {
    message[instance.name] = {};
    let checked = true;
    const config = initConfig.instances[instance.name].config;
    const spec = initConfig.spec;
    if (config.scaleMin < spec.scale.min || config.scaleMax > spec.scale.max) { // 校验规格扩缩容配置
      message[instance.name]['check-scale'] = `Illegal value of scale.`;
      checked = false;
    }
    if (config.scaleRoNumMin < spec.scaleRoNum.min || config.scaleRoNumMax > spec.scaleRoNum.max) { // 校验只读节点扩缩容配置
      message[instance.name]['check-scale-ro-num'] = `Illegal value of scale-ro-num.`;
      checked = false;
    }
    return checked;
  });

  const _waitingServing = async (instanceId, name) => {
    const daily = 10;
    let serving = false;
    let count = 6 * 60;
    while (!serving && count > 0) {
      console.info(`waiting instance: '${name}' Running...`);
      execSync(`sleep ${daily}`);
      try {
        const resp = await apiClient.describeDBClustersWithOptions(getAllInstanceRequest([], [instanceId]), runtime);
        if (resp.statusCode === 200 && resp.body.items.DBCluster.length === 1) {
          serving = resp.body.items.DBCluster[0].DBClusterStatus === 'Running';
        }
      } catch (error) {
      }
    }
    return serving;
  };

  //====================================================================================================================
  // 逻辑执行
  //====================================================================================================================
  const getInstances = async () => {
    const resp = await apiClient.describeDBClustersWithOptions(getInstanceRequest([]), runtime); // todo 仅能查到100个，需要循环分页查询
    if (resp.statusCode !== 200) {
      throw new Error(`get instances failure.`);
    }
    const instances = resp.body.items?.DBCluster || [];
    for (let instance of instances) {
      const serverlessResp = await apiClient.describeDBClusterServerlessConfWithOptions(getInstanceServerlessRequest(instance.DBClusterId), runtime);
      const endpointResp = await apiClient.describeDBClusterEndpointsWithOptions(getInstanceEndpointRequest(instance.DBClusterId), runtime);
      if (serverlessResp.statusCode === 200 && endpointResp.statusCode === 200) {
        instance.serverless = serverlessResp.body;
        instance.endpoint = endpointResp.body.items.filter(endpoint => endpoint.endpointType === 'Cluster');
      } else {
        throw new Error(`get instances failure, unable obtain configuration of serverless or endpoint for instance ${instance.DBClusterDescription}.`);
      }
    }
    return instances;
  };

  const tagInstances = async (message, tags, instances) => {
    for (let {name, request} of tagInstanceRequests(tags, instances)) {
      message[name] = {};
      try {
        const resp = await apiClient.tagResourcesWithOptions(request, runtime);
        if (resp.statusCode === 200) {
          message[name]['removing'] = 'removing instance successful.';
        } else {
          message[name]['removing'] = `removing instance failure.`;
        }
      } catch (error) {
        message[name]['removing'] = `removing instance failure: ${error.message}.`
          + `\n${error.data?.Recommend || ''}`;
      }
    }
  };

  const updateInstances = async (message, modifyingInstances) => {
    const validInstances = _updateValidateFilter(message, modifyingInstances);
    const excludeInstanceNames = [];
    for (let {id, name, request} of updateInstanceServerlessRequests(validInstances)) {
      try {
        if (await _waitingServing(id, name)) {
          const resp = await apiClient.modifyDBClusterServerlessConfWithOptions(request, runtime);
          if (resp.statusCode === 200) {
            if (!await _waitingServing(id, name)) {
              message[name]['update'] = `instance not in serving within 1H for update.`;
              excludeInstanceNames.push(name);
            } else {
              message[name]['update'] = `update instance successful.`;
            }
          } else {
            message[name]['update'] = `unable update instance.`;
            excludeInstanceNames.push(name);
          }
        } else {
          message[name]['update'] = `update instance failure, because of un-excepted status of instance and not in serving within 1H.`;
          excludeInstanceNames.push(name);
        }
      } catch (error) {
        message[name]['update'] = `update instance failure: ${error.message}`
          + `\n${error.data?.Recommend || ''}`;
        excludeInstanceNames.push(name);
      }
    }
    const updatingInstances = modifyingInstances.filter(instance => !excludeInstanceNames.includes(instance.name));
    for (let {name, request} of updateAllowedIpRequests(updatingInstances, initConfig.vpc.clusterIps)) {
      try {
        const resp = await apiClient.modifyDBClusterAccessWhitelistWithOptions(request, runtime);
        if (resp.statusCode === 200) {
          message[name]['whitelist'] = `update whitelist successful.`;
        } else {
          message[name]['whitelist'] = `update whitelist failure.`;
        }
      } catch (error) {
        message[name]['whitelist'] = `update whitelist failure: ${error.message}`
            + `\n${error.data?.Recommend || ''}`;
      }
    }
    for (let {name, request} of tagInstanceRequests([], updatingInstances)) {
      try {
        const resp = await apiClient.tagResourcesWithOptions(request, runtime);
        if (resp.statusCode === 200) {
          message[name]['update-tag'] = `tag instance for update successful.`;
        } else {
          message[name]['update-tag'] = `tag instance for update failure.`;
        }
      } catch (error) {
        message[name]['update-tag'] = `tag instance for update failure: ${error.message}`
            + `\n${error.data?.Recommend || ''}`;
      }
    }
    for (let {id, name, request} of resetAccountRequests(updatingInstances)) {
      try {
        if (await _waitingServing(id, name)) {
          const accountResp = await apiClient.describeAccountsWithOptions(getAccountRequest(id, name), runtime);
          if (accountResp.statusCode === 200 && accountResp.body.accounts?.length === 1) {
            const resp = await apiClient.resetAccountWithOptions(request, runtime);
            if (resp.statusCode === 200) {
              message[name]['reset-password'] = `reset password successful.`;
            } else {
              message[name]['reset-password'] = `reset password failure.`;
            }
          } else if (accountResp.body.accounts?.length === 0) {
            const resp = await apiClient.createAccountWithOptions(createAccountRequests([{ id, name }])[0].request, runtime);
            if (resp.statusCode === 200) {
              message[name]['create-account'] = `create account successful.`;
            } else {
              message[name]['create-account'] = `create account failure.`;
            }
          }
        } else {
          message[name]['update-account'] = `update account failure, because of un-excepted status of instance and not in serving within 1H.`;
        }
      } catch (error) {
        message[name]['reset-password'] = `reset password failure: ${error.message}`
            + `\n${error.data?.Recommend || ''}`;
      }
    }
  };

  const addInstances = async (message, creatingInstances) => {
    const validInstances = _createValidateFilter(message, creatingInstances);
    const createdInstances = [];
    for (let {name, request} of createInstanceRequests(validInstances)) {
      try {
        const resp = await apiClient.createDBClusterWithOptions(request, runtime);
        if (resp.statusCode === 200) {
          const id = resp.body.DBClusterId;
          if (await _waitingServing(id, name)) {
            const tagResp = await apiClient.tagResourcesWithOptions(
              tagInstanceRequests([], [{ id, name, }])[0].request,
              runtime,
            );
            if (tagResp.statusCode === 200) {
              message[name]['create-tag'] = `tag instance for create successful.`;
              createdInstances.push({
                id,
                name,
              });
              message[name]['create'] = 'create instance successful.'
            } else {
              message[name]['create-tag'] = `tag instance for create failure.`;
            }
          } else {
            message[name]['create'] = `unable ensure instance status, because of instance not in serving within 1H.`;
          }
        } else {
          message[name]['create'] = `create instance failure.`;
        }
      } catch (error) {
        message[name]['create'] = `create instance failure: ${error.message}`
          + `\n${error.data?.Recommend || ''}`;
      }
    }
    for (let {name, request} of createAccountRequests(createdInstances)) {
      try {
        const resp = await apiClient.createAccountWithOptions(request, runtime);
        if (resp.statusCode === 200) {
          message[name]['create-account'] = 'create instance account successful.'
        } else {
          message[name]['create-account'] = `create instance account failure.`;
        }
      } catch (error) {
        message[name]['create-account'] = `create instance account failure: ${error.message}`
          + `\n${error.data?.Recommend || ''}`;
      }
    }
  };

  //====================================================================================================================
  // 流程控制
  //====================================================================================================================
  const obtainExistInstances = async () => {
    try {
      const instances = await getInstances();
      const names = instances.map(instance => instance.tags.tag.filter(tag => tag.key === 'uname')[0].value);
      if (names.length !== new Set(names).size) {
        throw new Error('duplicate instance exists. Please check and handle this on console.');
      }
      return instances.map(instance => ({
        id: instance.DBClusterId,
        name: instance.tags.tag.filter(tag => tag.key === 'uname')[0].value,
        removing: !!instance.tags.tag.filter(tag => tag.key === 'removing').length,
        config: instance,
      }));
    } catch (error) {
      result.messages.push({
        id: '-',
        name: '-',
        message: `obtain exist instances failure. Cause: ${error.message}`
          + `\n${error.data?.Recommend || ''}`,
      })
      return null;
    }
  };

  const removeInstances = async (instances, existInstances) => {
    const message = {};
    const removingInstances = existInstances
      .filter(existInstance => !instances.map(instance => instance.name).includes(existInstance.name)) // 配置中不存在
      .filter(existInstances => !existInstances.removing); // 且还未配置删除
    await tagInstances(message, [{ key: 'removing', value: 'true' }], removingInstances);
    result.messages.push({
      action: 'removing',
      message,
    });
  };

  const modifyInstances = async (instances, existInstances) => {
    const message = {};
    const modifyingInstances = existInstances.filter(existInstance => { // 1. 配置重复; 2. 已标记删除; 3. 配置中不存在
      message[existInstance.name] = {};
      if (!instances.map(instance => instance.name).includes(existInstance.name)) { // 配置中不存在
        message[existInstance.name]['ignore'] = `unable to modify instance: '${existInstance.name}', non-configuration.`
        return false;
      }
      const instanceConfigs = instances.filter(i => i.name === existInstance.name);
      if (instanceConfigs.length !== 1) { // 配置重复
        message[existInstance.name]['problem-duplicate'] = `unable to modify instance: '${existInstance.name}', same instance in configuration.`;
        return false;
      }
      if (existInstance.removing) { // 标记删除
        message[existInstance.name]['problem-removing'] = `unable to modify instance: '${existInstance.name}', instance is removing.`;
        return false;
      }
      return true;
    });
    await updateInstances(message, modifyingInstances);
    result.messages.push({
      action: 'modify',
      message,
    });
  };

  const createInstances = async (instances, existInstances) => {
    const message = {};
    const creatingInstances = instances.filter(instance => {
      message[instance.name] = {};
      const exists = existInstances.filter(i => i.name === instance.name);
      if (exists.length > 1) { // 重复实例
        message[instance.name]['problem-duplicate'] = `ignore to create instance: '${instance.name}', duplicate instances exists.`;
        return false;
      }
      if (exists.length === 1) { // 已存在, 忽略
        const exist = exists[0];
        if (exist.removing) { // 已标记删除, 忽略并处理
          message[instance.name]['problem-removing'] = `ignore to create instance: '${instance.name}', un-handled removing instance.`;
          return false;
        } else { // 正常存在, 忽略
          message[instance.name]['problem-exist'] = `ignore to create instance: '${instance.name}', instance exists.`;
          return false;
        }
      }
      return true;
    });
    await addInstances(message, creatingInstances);
    result.messages.push({
      action: 'create',
      message,
    });
  };

  try {
    const instances = Object.keys(initConfig.instances).map(instanceName => ({
      id: null,
      name: instanceName,
      removing: false,
      config: {
        serverless: initConfig.instances[instanceName].config,
      },
    }));
    const existInstances = await obtainExistInstances();
    if (existInstances && (instances.length !== 0 || existInstances.length !== 0)) {
      await removeInstances(instances, existInstances);
      await modifyInstances(instances, existInstances);
      await createInstances(instances, existInstances);
    }
  } catch (error) {
    result.err = error.toString();
  } finally {
    initialing = false;
    result['date-time'] = new Date().toISOString();
    console.info(JSON.stringify(result, null, 2));
  }
};

watchFile(configFilePath, () => {
  lastModify = new Date();
});

setInterval(() => {
  if (!initialing && lastModify >= lastStartInit) { // 没有正在执行，且配置最后修改时间大于最后一个开始执行时间
    init();
  }
}, 5000);
