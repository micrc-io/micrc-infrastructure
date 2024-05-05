'use strict';

const execSync = require('child_process').execSync;
const readFileSync = require('fs').readFileSync;
const watchFile = require('fs').watchFile;
const yaml = require('js-yaml');
const alikafka = require('@alicloud/alikafka20190916');
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
  const paidTypeDesc = {
    0: 'PrePay',
    1: 'PostPay'
  };
  const whitelistName = 'user add';

  const clientConfig = new Config({
    accessKeyId: process.env['ALIBABA_CLOUD_ACCESS_KEY_ID'],
    accessKeySecret: process.env['ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
  });
  clientConfig.endpoint = `${initConfig.product}-vpc.${initConfig.region}.aliyuncs.com`;
  const apiClient = new alikafka.default(clientConfig);
  const runtime = new RuntimeOptions({
    autoretry: true,
    maxAttempts: 10,
    readTimeout: 60000,
    connectTimeout: 60000,
  });

  //====================================================================================================================
  // 请求构造
  //====================================================================================================================
  const getInstanceRequest = (tags, ids) => new alikafka.GetInstanceListRequest({
    regionId: initConfig.region,
    instanceId: ids || [],
    tag: tags.concat({ key: 'delegate', value: 'true' }).map(tag => new alikafka.GetInstanceListRequestTag({
      key: tag.key,
      value: tag.value,
    })),
  });

  const tagInstanceRequests = (tags, instances) => instances.map(instance => ({
    name: instance.name,
    request: new alikafka.TagResourcesRequest({
      regionId: initConfig.region,
      resourceType: 'instance',
      resourceId: [instance.id],
      tag: tags.map(tag => new alikafka.TagResourcesRequestTag(tag)),
    }),
  }));

  const startInstanceRequests = (instances) => instances.map(instance => ({
    id: instance.id,
    name: instance.name,
    request: new alikafka.StartInstanceRequest({
      regionId: initConfig.region,
      instanceId: instance.id,
      vpcId: initConfig.vpc.id,
      vSwitchId: initConfig.vpc.vSwitchIds[0],
      vSwitchIds: initConfig.vpc.vSwitchIds,
      name: instance.name,
      ...initConfig.default.deploy,
    }),
  }));

  const upgradeInstanceRequests = (instances) => instances.map(instance => ({
    type: instance.paidType,
    name: instance.name,
    request: new alikafka[`Upgrade${paidTypeDesc[instance.paidType]}OrderRequest`]({
      regionId: initConfig.region,
      instanceId: instance.id,
      specType: initConfig.instances[instance.name].config.create.specType,
      diskSize: initConfig.instances[instance.name].config.create.diskSize,
      ioMaxSpec: initConfig.instances[instance.name].config.create.ioMaxSpec,
      partitionNum: initConfig.instances[instance.name].config.create.partitionNum,
    }),
  }));

  const getAllowedIpListRequest = (instanceId) => new alikafka.GetAllowedIpListRequest({
    regionId: initConfig.region,
    instanceId,
  });

  const updateAllowedIpRequests = (action, ips, instances) => instances.map(instance => ({
    id: instance.id,
    name: instance.name,
    request: new alikafka.UpdateAllowedIpRequest({
      regionId: initConfig.region,
      instanceId: instance.id,
      updateType: action,
      allowedListIp: ips.join(','),
      ...initConfig.default.whitelist,
    }),
  }));

  const deleteAllowedIpRequest = (ip, instanceId) => new alikafka.UpdateAllowedIpRequest({
    regionId: initConfig.region,
    instanceId,
    updateType: 'delete',
    allowedListIp: ip,
    ...initConfig.default.whitelist,
  });

  const createInstanceRequests = (instances) => instances.map(instance => ({
    type: instance.paidType,
    name: instance.name,
    request: new alikafka[`Create${paidTypeDesc[instance.paidType]}OrderRequest`]({
      regionId: initConfig.region,
      resourceGroupId: initConfig.resourceGroupId,
      ...instance.config.create,
      ...initConfig.default.create,
      tag: [
        new alikafka[`Create${paidTypeDesc[instance.paidType]}OrderRequestTag`]({ key: 'delegate', value: 'true' }),
        new alikafka[`Create${paidTypeDesc[instance.paidType]}OrderRequestTag`]({ key: 'uname', value: instance.name }),
      ],
    }),
  }));

  //====================================================================================================================
  // 工具函数
  //====================================================================================================================
  const _upgradeValidateFilter = (message, modifyingInstances) => modifyingInstances.filter(instance => {
    message[instance.name] = {};
    let checked = true;
    const config = initConfig.instances[instance.name].config.create;
    const spec = initConfig.spec;
    if (!Object.keys(spec).includes(config.specType)) { // 校验规格类型
      message[instance.name]['check-spec-type'] = `Illegal value of spec-type.`;
      checked = false;
    }
    if (!Object.keys(spec[config.specType]).includes(config.ioMaxSpec)) { // 校验流量规格
      message[instance.name]['check-io-max-spec'] = `Illegal value of io-max-spec.`;
      checked = false;
    }
    const partitionNumSpec = spec[config.specType][config.ioMaxSpec].partitionNum;
    if (config.partitionNum < 0 || config.partitionNum > partitionNumSpec.max - partitionNumSpec.min) { // 校验分区数
      message[instance.name]['check-partition-number'] = `Illegal value of partition-number.`;
      checked = false;
    }
    const diskSizeSpec = spec[config.specType][config.ioMaxSpec].diskSize;
    if (config.diskSize < diskSizeSpec.min || config.diskSize > diskSizeSpec.max) { // 校验磁盘容量
      message[instance.name]['check-disk-size'] = `Illegal value of disk-size.`;
      checked = false;
    }
    if (config.specType === instance.config.specType // 规格类型相同
      && config.ioMaxSpec === instance.config.ioMaxSpec // 流量规格相同
      && config.diskSize === instance.config.diskSize // 磁盘容量相同
      && config.partitionNum + partitionNumSpec.min === instance.config.topicNumLimit // 分区总数相同
    ) {
      message[instance.name]['check-config'] = `upgrade ignore, because of same configuration.`;
      return false;
    }
    if (!checked) { // 配置检查未通过
      return false;
    }
    if (instance.config.viewInstanceStatusCode !== 2 && instance.config.viewInstanceStatusCode !== 0) { // 服务状态不合理
      message[instance.name]['check-instance-status'] = `Illegal state of instance.`;
      return false;
    }
    return true; // 剩下可更新的正常实例
  });;

  const _createValidateFilter = (message, creatingInstances) => creatingInstances.filter(instance => {
    message[instance.name] = {};
    let checked = true;
    const config = instance.config.create;
    const spec = initConfig.spec;
    if (!Object.keys(spec).includes(config.specType)) { // 校验规格类型
      message[instance.name]['check-spec-type'] = `Illegal value of spec-type.`;
      checked = false;
    }
    if (!Object.keys(spec[config.specType]).includes(config.ioMaxSpec)) { // 校验流量规格
      message[instance.name]['check-io-max-spec'] = `Illegal value of io-max-spec.`;
      checked = false;
    }
    const partitionNumSpec = spec[config.specType][config.ioMaxSpec].partitionNum;
    if (config.partitionNum < 0 || config.partitionNum > partitionNumSpec.max - partitionNumSpec.min) { // 校验分区数
      message[instance.name]['check-partition-number'] = `Illegal value of partition-number.`;
      checked = false;
    }
    const diskSizeSpec = spec[config.specType][config.ioMaxSpec].diskSize;
    if (config.diskSize < diskSizeSpec.min || config.diskSize > diskSizeSpec.max) { // 校验磁盘容量
      message[instance.name]['check-disk-size'] = `Illegal value of disk-size.`;
      checked = false;
    }
    return checked;
  });

  const _waitingServing = async (instanceId, name) => {
    const daily = 10;
    let serving = false;
    let count = 6 * 60;
    while (!serving && count > 0) {
      console.info(`waiting instance: '${name}' serving...`);
      execSync(`sleep ${daily}`);
      try {
        const resp = await apiClient.getInstanceListWithOptions(getInstanceRequest([], [instanceId]), runtime);
        if (resp.body.success && resp.body.instanceList.instanceVO.length === 1) {
          serving = resp.body.instanceList.instanceVO[0].viewInstanceStatusCode === 2;
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
    const resp = await apiClient.getInstanceListWithOptions(getInstanceRequest([]), runtime);
    if (!resp.body.success) {
      throw new Error(`get instances failure: ${resp.body.message}`);
    }
    return resp.body.instanceList.instanceVO || [];
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

  const upgradeInstances = async (message, modifyingInstances) => {
    const validInstances = _upgradeValidateFilter(message, modifyingInstances);
    const startingInstances = modifyingInstances.filter(instance => instance.config.viewInstanceStatusCode === 0);
    const excludeInstanceNames = [];
    for (let {id, name, request} of startInstanceRequests(startingInstances)) {
      try {
        const resp = await apiClient.startInstanceWithOptions(request, runtime);
        if (resp.body.success) {
          if (!await _waitingServing(id, name)) {
            message[name]['upgrade'] = `starting instance not in serving within 1H for upgrade.`;
            excludeInstanceNames.push(name);
          }
        } else {
          message[name]['upgrade'] = `unable start instance in serving for upgrade: ${resp.body.message}`;
          excludeInstanceNames.push(name);
        }
      } catch (error) {
        message[name]['upgrade'] = `unable start instance in serving for upgrade: ${error.message}`
          + `\n${error.data?.Recommend || ''}`;
        excludeInstanceNames.push(name);
      }
    }
    const upgradingInstances = validInstances.filter(instance => !excludeInstanceNames.includes(instance.name));
    for (let {type, id, name, request} of upgradeInstanceRequests(upgradingInstances)) {
      try {
        const resp = await apiClient[`upgrade${paidTypeDesc[type]}OrderWithOptions`](request, runtime);
        if (resp.body.success) {
          if (await _waitingServing(id, name)) {
            message[name]['upgrade'] = 'upgrade instance successful.';
          } else {
            message[name]['upgrade'] = 'instance not in serving within 1H. not sure of status.'
          }
        } else {
          message[name]['upgrade'] = `upgrade instance failure: ${resp.body.message}`;
        }
      } catch (error) {
        message[name]['upgrade'] = `upgrade instance failure: ${error.message}`
          + `\n${error.data?.Recommend || ''}`;
      }
    }
    const whitelistInstances = modifyingInstances.filter(instance => !excludeInstanceNames.includes(instance.name));
    for (let {id, name, request} of updateAllowedIpRequests('add', initConfig.vpc.clusterIps, whitelistInstances)) {
      let ips = null;
      let clean = true;
      try {
        const resp = await apiClient.getAllowedIpListWithOptions(getAllowedIpListRequest(id), runtime);
        if (resp.body.success) {
          ips = resp.body.allowedList.vpcList[0].allowedIpGroup[whitelistName] || [];
        } else {
          clean = false;
          message[name]['whitelist'] = `unable update whitelist, obtain exist whitelist failure: ${resp.body.message}`;
        }
      } catch (error) {
        clean = false;
        message[name]['whitelist'] = `unable update whitelist, obtain exist whitelist failure: ${error.message}`
          + `\n${error.data?.Recommend || ''}`;
      }
      if (ips) {
        try {
          for (let ip of ips) {
            const resp = await apiClient.updateAllowedIpWithOptions(deleteAllowedIpRequest(ip, id), runtime);
            if (!resp.body.success) {
              message[name]['whitelist'] = `unable update whitelist, clean exist whitelist failure: ${resp.body.message}`;
              clean = false;
            }
          }
        } catch (error) {
          message[name]['whitelist'] = `unable update whitelist, clean exist whitelist failure: ${error.message}`
            + `\n${error.data?.Recommend || ''}`;
          clean = false;
        }
      }
      if (clean) {
        try {
          const resp = await apiClient.updateAllowedIpWithOptions(request, runtime);
          if (resp.body.success) {
            message[name]['whitelist'] = `update whitelist successful.`;
          } else {
            message[name]['whitelist'] = `update whitelist failure: ${resp.body.message}`;
          }
        } catch (error) {
          message[name]['whitelist'] = `update whitelist failure: ${error.message}`
            + `\n${error.data?.Recommend || ''}`;
        }
      }
    }
  };

  const addInstances = async (message, creatingInstances) => {
    const validInstances = _createValidateFilter(message, creatingInstances);
    const createdInstances = [];
    for (let {type, name, request} of createInstanceRequests(validInstances)) {
      let created = true;
      try {
        const resp = await apiClient[`create${paidTypeDesc[type]}OrderWithOptions`](request, runtime);
        if (!resp.body.success) {
          created = false;
          message[name]['create'] = `create instance failure: ${resp.body.message}`;
        }
      } catch (error) {
        created = false;
        message[name]['create'] = `create instance failure: ${error.message}`
          + `\n${error.data?.Recommend || ''}`;
      }
      if (created) {
        try {
          execSync('sleep 10');
          const resp = await apiClient.getInstanceListWithOptions(
            getInstanceRequest([{ key: 'uname', value: name }]),
            runtime,
          );
          if (resp.body.success) {
            if (resp.body.instanceList.instanceVO.length === 1) {
              const instance = resp.body.instanceList.instanceVO[0];
              createdInstances.push({
                id: instance.instanceId,
                name,
                removing: !!instance.tags.tagVO.filter(tag => tag.key === 'removing').length,
                paidType: instance.paidType,
                config: instance,
              });
            } else {
              message[name]['create'] = 'create instance failure or more then one instance exists.'
            }
          } else {
            message[name]['create'] = `unable ensure created because of obtain instance failure: ${resp.body.message}`;
          }
        } catch (error) {
          message[name]['create'] = `unable ensure created because of obtain instance failure: ${error.message}`
            + `\n${error.data?.Recommend || ''}`;
        }
      }
    }
    const startedInstances = [];
    for (let {id, name, request} of startInstanceRequests(createdInstances)) {
      try {
        const resp = await apiClient.startInstanceWithOptions(request, runtime);
        if (resp.body.success) {
          if (await _waitingServing(id, name)) {
            startedInstances.push({
              id,
              name,
            });
          } else {
            message[name]['deploy'] = `starting instance not in serving within 1H for create.`;
          }
        } else {
          message[name]['deploy'] = `unable start instance in serving for create: ${resp.body.message}`;
        }
      } catch (error) {
        message[name]['deploy'] = `unable start instance in serving for create: ${error.message}`
          + `\n${error.data?.Recommend || ''}`;
      }
    }
    for (let {name, request} of updateAllowedIpRequests('add', initConfig.vpc.clusterIps, startedInstances)) {
      try {
        const resp = await apiClient.updateAllowedIpWithOptions(request, runtime);
        if (resp.body.success) {
          message[name]['whitelist'] = `add whitelist successful.`;
        } else {
          message[name]['whitelist'] = `add whitelist failure: ${resp.body.message}`;
        }
      } catch (error) {
        message[name]['whitelist'] = `add whitelist failure: ${error.message}`
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
      const names = instances.map(instance => instance.tags.tagVO.filter(tag => tag.key === 'uname')[0].value);
      if (names.length !== new Set(names).size) {
        throw new Error('duplicate instance exists. Please check and handle this on console.');
      }
      return instances.map(instance => ({
        id: instance.instanceId,
        name: instance.tags.tagVO.filter(tag => tag.key === 'uname')[0].value,
        removing: !!instance.tags.tagVO.filter(tag => tag.key === 'removing').length,
        paidType: instance.paidType,
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
    const modifyingInstances = existInstances.filter(existInstance => { // 1. 配置重复; 2. 支付模式改变; 3. 已标记删除; 4. 配置中不存在
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
      const instanceConfig = instanceConfigs[0];
      if (instanceConfig.paidType !== existInstance.paidType) { // 支付改变
        message[existInstance.name]['problem-paid-type'] =
          `unable to modify instance: '${existInstance.name}', changing of paid-type. `
          + `Exist is ${existInstance.paidType}, config is ${instanceConfig.paidType}.`;
        return false;
      }
      if (existInstance.removing) { // 标记删除
        message[existInstance.name]['problem-removing'] = `unable to modify instance: '${existInstance.name}', instance is removing.`;
        return false;
      }
      return true;
    });
    await upgradeInstances(message, modifyingInstances);
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
      paidType: initConfig.instances[instanceName].config.create.paidType,
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
