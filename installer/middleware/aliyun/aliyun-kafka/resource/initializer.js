'use strict';

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

const maxTopicNum = 40000;
const maxGroupNum = 40000 * 2;

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
  const getInstanceRequest = (instanceName) => new alikafka.GetInstanceListRequest({
    regionId: initConfig.region,
    tag: [{ key: 'delegate', value: 'true' }, { key: 'uname', value: instanceName }]
      .map(tag => new alikafka.GetInstanceListRequestTag({
        key: tag.key,
        value: tag.value,
      })),
  });

  const getTopicListRequest = (instanceId) => new alikafka.GetTopicListRequest({
    regionId: initConfig.region,
    instanceId,
    pageSize: maxTopicNum,
  });

  const getConsumerListRequest = (instanceId) => new alikafka.GetConsumerListRequest({
    regionId: initConfig.region,
    instanceId,
    pageSize: maxGroupNum,
  });

  const tagTopicRequests = (instance, tags, topics) => topics.map(topic => ({
    name: topic.topic,
    request: new alikafka.TagResourcesRequest({
      regionId: initConfig.region,
      instanceId: instance.id,
      resourceType: 'topic',
      resourceId: [`Kafka_${instance.id}_${topic.topic}`],
      tag: tags.map(tag => new alikafka.TagResourcesRequestTag(tag)),
    }),
  }));

  const tagConsumerRequests = (instance, tags, consumers) => consumers.map(consumer => ({
    name: consumer.consumerId,
    request: new alikafka.TagResourcesRequest({
      regionId: initConfig.region,
      instanceId: instance.id,
      resourceType: 'consumergroup',
      resourceId: [`Kafka_${instance.id}_${consumer.consumerId}`],
      tag: tags.map(tag => new alikafka.TagResourcesRequestTag(tag)),
    }),
  }));

  const modifyPartitionNumRequest = (instance, topics) => topics.map(topic => ({
    name: topic.topic,
    request: new alikafka.ModifyPartitionNumRequest({
      regionId: initConfig.region,
      instanceId: instance.id,
      topic: topic.topic,
      addPartitionNum: topic.addPartitionNum,
    }),
  }));

  const createTopicRequests = (instance, topics) => topics.map(topic => ({
    name: topic.name,
    request: new alikafka.CreateTopicRequest({
      regionId: initConfig.region,
      instanceId: instance.id,
      topic: topic.name,
      remark: topic.name,
      partitionNum: topic.partitionNum,
      tag: [{ key: 'delegate', value: 'true' }, { key: 'domain', value: topic.domain }, { key: 'instance', value: instance.name }]
        .map(tag => new alikafka.CreateTopicRequestTag(tag)),
    }),
  }));

  const createConsumerRequests = (instance, consumers) => consumers.map(consumer => ({
    name: consumer.name,
    request: new alikafka.CreateConsumerGroupRequest({
      regionId: initConfig.region,
      instanceId: instance.id,
      consumerId: consumer.name,
      remark: consumer.name,
      tag: [{ key: 'delegate', value: 'true' }, { key: 'domain', value: consumer.domain }, { key: 'instance', value: instance.name }]
        .map(tag => new alikafka.CreateConsumerGroupRequestTag(tag)),
    }),
  }));

  //====================================================================================================================
  // 逻辑执行
  //====================================================================================================================
  const getInstance = async (instanceName) => {
    const instanceResp = await apiClient.getInstanceListWithOptions(getInstanceRequest(instanceName), runtime);
    if (!instanceResp.body.success) {
      throw new Error(`obtain instance for name: '${instanceName}' failure: ${instanceResp.body.message}`);
    }
    if (instanceResp.body.instanceList.instanceVO.length !== 1) {
      throw new Error(`un-excepted count of instances for name: '${instanceName}'.`);
    }
    if (instanceResp.body.instanceList.instanceVO[0].viewInstanceStatusCode !== 2) {
      throw new Error(`un-excepted status of instances for name: '${instanceName}'.`);
    }
    return instanceResp.body.instanceList.instanceVO[0];
  };

  const getTopicsAndGroups = async (instance) => {
    const topicsResp = await apiClient.getTopicListWithOptions(getTopicListRequest(instance.id), runtime);
    if (!topicsResp.body.success) {
      throw new Error(`obtain topics for instance: '${instance.name}' failure: ${topicsResp.body.message}`);
    }

    const consumersResp = await apiClient.getConsumerListWithOptions(getConsumerListRequest(instance.id), runtime);
    if (!consumersResp.body.success) {
      throw new Error(`obtain group for instance: '${instance.name}' failure: ${consumersResp.body.message}`);
    }

    return {
      topics: (topicsResp.body.topicList.topicVO || [])
        .filter(topic => topic.tags.tagVO.filter(tag => tag.key === 'delegate' && tag.value === 'true').length === 1),
      groups: (consumersResp.body.consumerList.consumerVO || [])
        .filter(consumer => consumer.tags.tagVO.filter(tag => tag.key === 'delegate' && tag.value === 'true').length === 1),
    };
  };

  const tagTopicsAndGroups = async (message, instance, tags, topics, groups) => {
    for (let {name, request} of tagTopicRequests(instance, tags, topics)) {
      try {
        const resp = await apiClient.tagResourcesWithOptions(request, runtime);
        if (resp.statusCode === 200) {
          message.topics[name] = `removing topic for instance '${instance.name}' successful.`;
        } else {
          message.topics[name] = `removing topic for instance '${instance.name}' failure.`;
        }
      } catch (error) {
        message.topics[name] = `removing topic for instance '${instance.name}' failure.`
          + `\n${error.data?.Recommend || ''}`;
      }
    }
    for (let {name, request} of tagConsumerRequests(instance, tags, groups)) {
      try {
        const resp = await apiClient.tagResourcesWithOptions(request, runtime);
        if (resp.statusCode === 200) {
          message.groups[name] = `removing group for instance '${instance.name}' successful.`;
        } else {
          message.groups[name] = `removing group for instance '${instance.name}' failure.`;
        }
      } catch (error) {
        message.groups[name] = `removing group for instance '${instance.name}' failure.`
          + `\n${error.data?.Recommend || ''}`;
      }
    }
  };

  const updateTopicsAndGroups = async (message, instance, topics, groups) => {
    message.groups = `modify group: ${JSON.stringify(groups)} for instance: '${instance.name}' un-supported.`;
    for (let {name, request} of modifyPartitionNumRequest(instance, topics)) {
      try {
        const resp = await apiClient.modifyPartitionNumWithOptions(request, runtime);
        if (resp.body.success) {
          message.topics[name] = `update topic partition number for instance: '${instance.name}' successful.`;
        } else {
          message.topics[name] = `update topic partition number for instance: '${instance.name}' failure: ${resp.body.message}`;
        }
      } catch (error) {
        message.topics[name] = `update topic partition number for instance: '${instance.name}' failure: ${error.message}`
          + `\n${error.data?.Recommend || ''}`;
      }
    }
  };

  const addTopicsAndGroups = async (message, instance, topics, groups) => {
    for (let {name, request} of createTopicRequests(instance, topics)) {
      try {
        const resp = await apiClient.createTopicWithOptions(request, runtime);
        if (resp.body.success) {
          message.topics[name] = `add topic for instance: '${instance.name}' successful.`;
        } else {
          message.topics[name] = `add topic for instance: '${instance.name}' failure: ${resp.body.message}`;
        }
      } catch (error) {
        message.topics[name] = `add topic for instance: '${instance.name}' failure: ${error.message}`
          + `\n${error.data?.Recommend || ''}`;
      }
    }
    for (let {name, request} of createConsumerRequests(instance, groups)) {
      try {
        const resp = await apiClient.createConsumerGroupWithOptions(request, runtime);
        if (resp.body.success) {
          message.groups[name] = `add group for instance: '${instance.name}' successful.`;
        } else {
          message.groups[name] = `add group for instance: '${instance.name}' failure: ${resp.body.message}`;
        }
      } catch (error) {
        message.groups[name] = `add group for instance: '${instance.name}' failure: ${error.message}`
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
        endpoint: instance.domainEndpoint,
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

  const obtainTopicsAndGroups = async (instance) => {
    try {
      return await getTopicsAndGroups(instance);
    } catch (error) {
      result.messages.push({
        id: instance.id,
        name: instance.name,
        endpoint: instance.endpoint,
        message: `obtain topics and groups failure. Cause: ${error.message}`
          + `\n${error.data?.Recommend || ''}`,
      })
      return null;
    }
  };

  const removeTopicsAndGroups = async (instance, resources, existResources) => {
    const message = {
      topics: {},
      groups: {},
    };
    const removingTopics = existResources.topics.filter(topic => !resources.topics.map(t => t.name).includes(topic.topic));
    const removingGroups = existResources.groups.filter(group => !resources.groups.map(g => g.name).includes(group.consumerId));
    await tagTopicsAndGroups(message, instance, [{ key: 'removing', value: 'true' }], removingTopics, removingGroups);
    result.messages.push({
      id: instance.id,
      name: instance.name,
      endpoint: instance.endpoint,
      action: 'removing',
      message,
    });
  };

  const modifyTopicsAndGroups = async (instance, resources, existResources) => {
    const message = {
      topics: {},
      groups: {},
    };
    const modifyingTopics = existResources.topics
      .filter(topic => resources.topics.map(t => t.name).includes(topic.topic))
      .filter(topic => {
        const topics = resources.topics.filter(t => t.name === topic.topic);
        if (topics.length !== 1) {
          message.topics[topic.topic] = `unable to modify topic: '${topic.topic}', same topic in configuration.`;
          return false;
        }
        if (topics[0].partitionNum < topic.partitionNum) {
          message.topics[topic.topic] = `unable to modify topic: ${topic.topic}, `
            + `unable to reduce partition number, current is: ${topic.partitionNum} - expect is ${topics[0].partitionNum}.`;
          return false;
        }
        if (topics[0].partitionNum === topic.partitionNum) {
          message.topics[topic.topic] = `modify topic: '${topic.topic}' ignore, same partition number: ${topic.partitionNum}.`;
          return false;
        }
        topic.addPartitionNum = topics[0].partitionNum - topic.partitionNum;
        return true;
      }); // 分区数比当前增加的
    const modifyingGroups = existResources.groups.filter(group => resources.groups.map(g => g.name).includes(group.consumerId));
    await updateTopicsAndGroups(message, instance, modifyingTopics, modifyingGroups);
    result.messages.push({
      id: instance.id,
      name: instance.name,
      endpoint: instance.endpoint,
      action: 'modify',
      message,
    });
  };

  const createTopicsAndGroups = async (instance, resources, existResources) => {
    const message = {
      topics: {},
      groups: {},
    };
    const creatingTopics = resources.topics.filter(topic => !existResources.topics.map(t => t.topic).includes(topic.name));
    const creatingGroups = resources.groups.filter(group => !existResources.groups.map(g => g.consumerId).includes(group.name));
    await addTopicsAndGroups(message, instance, creatingTopics, creatingGroups);
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
            topics: pre.topics.concat(initConfig.instances[instanceName][curr].topics.map(topic => ({
              ...topic,
              domain: curr
            }))),
            groups: pre.groups.concat(initConfig.instances[instanceName][curr].groups.map(group => ({
              ...group,
              domain: curr
            }))),
          }), { topics: [], groups: [] });
        const existResources = await obtainTopicsAndGroups(instance);
        if (existResources) {
          await removeTopicsAndGroups(instance, resources, existResources);
          await modifyTopicsAndGroups(instance, resources, existResources);
          await createTopicsAndGroups(instance, resources, existResources);
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
