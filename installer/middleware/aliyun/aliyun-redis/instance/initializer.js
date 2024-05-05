'use strict';

const execSync = require('child_process').execSync;
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
    err: '',
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
  const getInstanceRequest = (tags, ids = []) => new redis.DescribeInstancesRequest({
    regionId: initConfig.region,
    instanceIds: ids.join(','),
    tag: tags.concat({ key: 'delegate', value: 'true' }).map(tag => new redis.DescribeInstancesRequestTag(tag)),
    pageSize: 50,
  });

  const tagInstanceRequests = (tags, instances) => instances.map(instance => ({
    name: instance.name,
    request: new redis.TagResourcesRequest({
      regionId: initConfig.region,
      resourceType: 'INSTANCE',
      resourceId: [instance.id],
      tag: tags.map(tag => new redis.TagResourcesRequestTag(tag)),
    }),
  }));

  const updateInstanceShardClassRequests = (instances) => instances.map(instance => ({
    id: instance.id,
    name: instance.name,
    request: new redis.ModifyInstanceSpecRequest({
      regionId: initConfig.region,
      instanceId: instance.id,
      instanceClass: initConfig.instances[instance.name].config.shardClass,
    }),
  }));

  const updateInstanceShardCountRequests = (instances) => instances.map(instance => ({
    id: instance.id,
    name: instance.name,
    request: new redis.AddShardingNodeRequest({
      instanceId: instance.id,
      shardCount: initConfig.instances[instance.name].config.shardCount - instance.config.shardCount,
    }),
  }));

  const updateAllowedIpRequests = (instances, ips = []) => instances.map(instance => ({
    id: instance.id,
    name: instance.name,
    request: new redis.ModifySecurityIpsRequest({
      instanceId: instance.id,
      securityIps: ips.join(','),
      ...initConfig.default.whitelist,
    }),
  }));

  const resetAccountPasswordRequests = (instances) => instances.map(instance => ({
    name: instance.name,
    request: new redis.ResetAccountPasswordRequest({
      instanceId: instance.id,
      accountName: instance.id,
      accountPassword: initConfig.instances[instance.name].account.password,
    }),
  }));

  const createInstanceRequests = (instances) => instances.map(instance => ({
    name: instance.name,
    request: new redis.CreateInstanceRequest({
      regionId: initConfig.region,
      zoneId: initConfig.zones[0],
      secondaryZoneId: initConfig.zones[1],
      instanceName: instance.name,
      resourceGroupId: initConfig.resourceGroupId,
      vpcId: initConfig.vpc.id,
      vSwitchId: initConfig.vpc.vSwitchIds[0],
      instanceClass: instance.config.shardClass,
      shardCount: instance.config.shardCount,
      password: instance.account.password,
      ...initConfig.default.create,
      tag: [
        new redis.CreateInstanceRequestTag({ key: 'delegate', value: 'true' }),
        new redis.CreateInstanceRequestTag({ key: 'uname', value: instance.name }),
      ],
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
    if (!Object.keys(spec.shardClass).includes(config.shardClass)) { // 校验实例类型
      message[instance.name]['check-shard-class'] = `Illegal value of shard-class.`;
      checked = false;
    }
    if (config.shardCount < spec.shardCount.min || config.shardCount > spec.shardCount.max) { // 校验分片数量
      message[instance.name]['check-shard-count'] = `Illegal value of shard-count.`;
      checked = false;
    }
    if (config.shardCount - instance.config.shardCount > 32 || config.shardCount - instance.config.shardCount < 0) { // 校验分片增量
      message[instance.name]['check-shard-count-increase'] = `Illegal value of shard-count-increase.`;
      checked = false;
    }
    if (config.shardCount === instance.config.shardCount
      && config.shardClass === instance.config.shardClass
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
    if (!Object.keys(spec.shardClass).includes(config.shardClass)) { // 校验实例类型
      message[instance.name]['check-shard-class'] = `Illegal value of shard-class.`;
      checked = false;
    }
    if (config.shardCount < spec.shardCount.min || config.shardCount > spec.shardCount.max) { // 校验分片数量
      message[instance.name]['check-shard-count'] = `Illegal value of shard-count.`;
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
        const resp = await apiClient.describeInstancesWithOptions(getInstanceRequest([], [instanceId]), runtime);
        if (resp.statusCode === 200 && resp.body.instances.KVStoreInstance.length === 1) {
          serving = resp.body.instances.KVStoreInstance[0].instanceStatus === 'Normal';
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
    const resp = await apiClient.describeInstancesWithOptions(getInstanceRequest([]), runtime); // todo 仅能查到50个，需要循环分页查询
    if (resp.statusCode !== 200) {
      throw new Error(`get instances failure.`);
    }
    return resp.body.instances?.KVStoreInstance || [];
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
    const updatingShardClassInstances = validInstances.filter(
      instance => instance.config.shardClass !== initConfig.instances[instance.name].config.shardClass
    );
    const updatingShardCountInstances = validInstances.filter(
      instance => instance.config.shardCount !== initConfig.instances[instance.name].config.shardCount
    );
    const excludeInstanceNames = [];
    for (let {id, name, request} of updateInstanceShardClassRequests(updatingShardClassInstances)) {
      try {
        if (await _waitingServing(id, name)) {
          const resp = await apiClient.modifyInstanceSpecWithOptions(request, runtime);
          if (resp.statusCode === 200) {
            if (!await _waitingServing(id, name)) {
              message[name]['update-instance-class'] = `instance not in serving within 1H for update.`;
              excludeInstanceNames.push(name);
            }
          } else {
            message[name]['update-instance-class'] = `unable update instance-class.`;
            excludeInstanceNames.push(name);
          }
        } else {
          message[name]['update-instance-class'] = `update instance-class failure, because of un-excepted status of instance and not in serving within 1H.`;
          excludeInstanceNames.push(name);
        }
      } catch (error) {
        message[name]['update-instance-class'] = `update instance-class failure: ${error.message}`
          + `\n${error.data?.Recommend || ''}`;
        excludeInstanceNames.push(name);
      }
    }
    for (let {id, name, request} of updateInstanceShardCountRequests(updatingShardCountInstances)) {
      try {
        if (await _waitingServing(id, name)) {
          const resp = await apiClient.addShardingNodeWithOptions(request, runtime);
          if (resp.statusCode === 200) {
            if (!await _waitingServing(id, name)) {
              message[name]['update-shard-count'] = `instance not in serving within 1H for update.`;
              excludeInstanceNames.push(name);
            }
          } else {
            message[name]['update-shard-count'] = `unable update shard-count.`;
            excludeInstanceNames.push(name);
          }
        } else {
          message[name]['update-shard-count'] = `update shard-count failure, because of un-excepted status of instance and not in serving within 1H.`;
          excludeInstanceNames.push(name);
        }
      } catch (error) {
        message[name]['update-shard-count'] = `update shard-count failure: ${error.message}`
          + `\n${error.data?.Recommend || ''}`;
        excludeInstanceNames.push(name);
      }
    }
    const updatingInstances = modifyingInstances.filter(instance => !excludeInstanceNames.includes(instance.name));
    for (let {name, request} of updateAllowedIpRequests(updatingInstances, initConfig.vpc.clusterIps)) {
      try {
        const resp = await apiClient.modifySecurityIpsWithOptions(request, runtime);
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
    for (let {name, request} of resetAccountPasswordRequests(updatingInstances)) {
      try {
        const resp = await apiClient.resetAccountPasswordWithOptions(request, runtime);
        if (resp.statusCode === 200) {
          message[name]['reset-password'] = `reset password successful.`;
        } else {
          message[name]['reset-password'] = `reset password failure.`;
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
        const resp = await apiClient.createInstanceWithOptions(request, runtime);
        if (resp.statusCode === 200) {
          const id = resp.body.instanceId;
          if (await _waitingServing(id, name)) {
            createdInstances.push({
              id,
              name,
            });
            message[name]['create'] = `create instance successful.`;
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
    for (let {name, request} of updateAllowedIpRequests(createdInstances, initConfig.vpc.clusterIps)) {
      try {
        const resp = await apiClient.modifySecurityIpsWithOptions(request, runtime);
        if (resp.statusCode === 200) {
          message[name]['whitelist'] = `create whitelist successful.`;
        } else {
          message[name]['whitelist'] = `create whitelist failure.`;
        }
      } catch (error) {
        message[name]['whitelist'] = `create whitelist failure: ${error.message}`
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
        id: instance.instanceId,
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
      account: initConfig.instances[instanceName].account,
      config: initConfig.instances[instanceName].config,
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
