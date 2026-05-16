<script>
import Plugin from '../../mixins/plugin'

export default {
  name: 'Xray',
  mixins: [Plugin],
  data () {
    return {
      key: 'plugin.xray',
      labelCol: { span: 4 },
      wrapperCol: { span: 20 },
      subscriptionsText: '',
      nodesText: '',
      allowedCountriesText: '',
      allowedOwnersText: '',
      maxDelayMs: 0,
      bootstrapBatchTimeout: 30,
      bootstrapCandidateLimit: 31,
      bootstrapProbeSamples: 2,
      subscriptionSyncLowWatermark: 0,
      cacheRefreshEnabled: true,
      cacheRefreshInterval: 21600,
      cacheBatchTimeout: 30,
      cacheRefreshBatchSize: 31,
      cacheRefreshProbeSamples: 2,
      rules: [],
    }
  },
  computed: {
    runtimePort () {
      return this.status.plugin.xray ? this.status.plugin.xray.port : 0
    },
  },
  methods: {
    ready () {
      // Init local data from config
      this.subscriptionsText = (this.config.plugin.xray.subscriptions || []).join('\n')
      this.nodesText = (this.config.plugin.xray.nodes || []).join('\n')
      this.allowedCountriesText = (this.config.plugin.xray.allowedCountries || []).join(', ')
      this.allowedOwnersText = (this.config.plugin.xray.allowedOwners || []).join(', ')
      this.maxDelayMs = this.config.plugin.xray.maxDelayMs || 0
      this.bootstrapBatchTimeout = this.config.plugin.xray.bootstrapBatchTimeout ?? this.config.plugin.xray.initialRefreshBatchTimeout ?? 30
      this.bootstrapCandidateLimit = this.config.plugin.xray.bootstrapCandidateLimit ?? this.config.plugin.xray.initialRefreshBatchSize ?? 31
      this.bootstrapProbeSamples = this.config.plugin.xray.bootstrapProbeSamples ?? this.config.plugin.xray.initialRefreshProbeSamples ?? 2
      this.subscriptionSyncLowWatermark = this.config.plugin.xray.subscriptionSyncLowWatermark ?? 0
      this.cacheRefreshEnabled = this.config.plugin.xray.cacheRefreshEnabled !== false
      this.cacheRefreshInterval = this.config.plugin.xray.cacheRefreshInterval ?? 21600
      this.cacheBatchTimeout = this.config.plugin.xray.cacheBatchTimeout ?? 30
      this.cacheRefreshBatchSize = this.config.plugin.xray.cacheRefreshBatchSize ?? 31
      this.cacheRefreshProbeSamples = this.config.plugin.xray.cacheRefreshProbeSamples ?? 2
      // Deep copy rules
      this.rules = JSON.parse(JSON.stringify(this.config.plugin.xray.rules || []))
    },
    async applyBefore () {
      // Sync local data to config
      this.config.plugin.xray.subscriptions = this.subscriptionsText.split('\n').map(s => s.trim()).filter(s => s)
      this.config.plugin.xray.nodes = this.nodesText.split('\n').map(s => s.trim()).filter(s => s)
      this.config.plugin.xray.allowedCountries = this.allowedCountriesText
        .split(/[\s,;]+/)
        .map(s => s.trim().toUpperCase())
        .filter(s => s)
      this.config.plugin.xray.allowedOwners = this.allowedOwnersText
        .split(/[\s,;]+/)
        .map(s => s.trim())
        .filter(s => s)
      this.config.plugin.xray.maxDelayMs = Number.isFinite(Number(this.maxDelayMs)) && Number(this.maxDelayMs) >= 0
        ? Math.floor(Number(this.maxDelayMs))
        : 0
      this.config.plugin.xray.bootstrapBatchTimeout = Number.isFinite(Number(this.bootstrapBatchTimeout)) && Number(this.bootstrapBatchTimeout) >= 15
        ? Math.floor(Number(this.bootstrapBatchTimeout))
        : 30
      this.config.plugin.xray.bootstrapCandidateLimit = Number.isFinite(Number(this.bootstrapCandidateLimit)) && Number(this.bootstrapCandidateLimit) >= 1
        ? Math.floor(Number(this.bootstrapCandidateLimit))
        : 31
      delete this.config.plugin.xray.bootstrapBatchSize
      this.config.plugin.xray.bootstrapProbeSamples = Number.isFinite(Number(this.bootstrapProbeSamples)) && Number(this.bootstrapProbeSamples) >= 1
        ? Math.floor(Number(this.bootstrapProbeSamples))
        : 2
      delete this.config.plugin.xray.initialRefreshBatchTimeout
      delete this.config.plugin.xray.initialRefreshBatchSize
      delete this.config.plugin.xray.initialRefreshProbeSamples
      this.config.plugin.xray.subscriptionSyncLowWatermark = Number.isFinite(Number(this.subscriptionSyncLowWatermark)) && Number(this.subscriptionSyncLowWatermark) >= 0
        ? Math.floor(Number(this.subscriptionSyncLowWatermark))
        : 0
      this.config.plugin.xray.cacheRefreshEnabled = this.cacheRefreshEnabled !== false
      this.config.plugin.xray.cacheRefreshInterval = Number.isFinite(Number(this.cacheRefreshInterval)) && Number(this.cacheRefreshInterval) > 0
        ? Math.floor(Number(this.cacheRefreshInterval))
        : 21600
      this.config.plugin.xray.cacheBatchTimeout = Number.isFinite(Number(this.cacheBatchTimeout)) && Number(this.cacheBatchTimeout) >= 15
        ? Math.floor(Number(this.cacheBatchTimeout))
        : 30
      this.config.plugin.xray.cacheRefreshBatchSize = Number.isFinite(Number(this.cacheRefreshBatchSize)) && Number(this.cacheRefreshBatchSize) >= 1
        ? Math.floor(Number(this.cacheRefreshBatchSize))
        : 31
      delete this.config.plugin.xray.cacheRefreshAdaptiveBatching
      delete this.config.plugin.xray.cacheRefreshMinBatchSize
      delete this.config.plugin.xray.cacheRefreshMaxBatchSize
      this.config.plugin.xray.cacheRefreshProbeSamples = Number.isFinite(Number(this.cacheRefreshProbeSamples)) && Number(this.cacheRefreshProbeSamples) >= 1
        ? Math.floor(Number(this.cacheRefreshProbeSamples))
        : 2
      this.config.plugin.xray.rules = this.rules.filter(r => r.domain)

      // If enabled, restart is handled by apply() logic if config changes?
      // The Plugin mixin usually saves config.
      // If status is enabled, we might need to explicit restart or let the watcher handle it.
      // In Git plugin, it explicitly closes and restarts.
      if (this.status.plugin.xray.enabled) {
        await this.$api.plugin.xray.restart()
      }
    },
    addRule () {
      this.rules.push({ domain: '', outboundTag: 'balancer-proxy' })
    },
    delRule (index) {
      this.rules.splice(index, 1)
    },
  },
}
</script>

<template>
  <ds-container>
    <template slot="header">
      Xray 代理设置
    </template>
    <template slot="header-right">
      集成 Xray Core 以支持 VLESS/VMess 等高级协议
    </template>

    <div v-if="config">
      <a-form layout="horizontal">
        <a-form-item label="启用插件" :label-col="labelCol" :wrapper-col="wrapperCol">
          <a-checkbox v-model="config.plugin.xray.enabled">
            随应用启动
          </a-checkbox>
          <a-tag v-if="status.plugin.xray.enabled" color="green">
            当前已启动 (端口: {{ runtimePort }})
          </a-tag>
          <a-tag v-else color="red">
            当前未启动
          </a-tag>
        </a-form-item>

        <a-form-item label="监听端口" :label-col="labelCol" :wrapper-col="wrapperCol">
          <a-input-number v-model="config.plugin.xray.localPort" :min="0" :max="65535" />
          <span style="margin-left: 10px; color: #999;">(0 表示自动选择可用端口；非 0 则强制使用该端口，占用会报错)</span>
        </a-form-item>

        <a-form-item label="启动节点上限" :label-col="labelCol" :wrapper-col="wrapperCol">
          <a-input-number v-model="config.plugin.xray.startupNodeLimit" :min="1" :max="200" />
          <span style="margin-left: 10px; color: #999;">(启动时最多使用多少个已缓存节点，数值越小越快)</span>
        </a-form-item>

        <a-form-item label="启动前复检超时" :label-col="labelCol" :wrapper-col="wrapperCol">
          <a-input-number v-model="bootstrapBatchTimeout" :min="15" :max="7200" />
          <span style="margin-left: 10px; color: #999;">(秒；仅第一阶段使用，启动前快速复检上次缓存节点)</span>
        </a-form-item>

        <a-form-item label="启动前候选节点上限" :label-col="labelCol" :wrapper-col="wrapperCol">
          <a-input-number v-model="bootstrapCandidateLimit" :min="1" :max="10000" />
          <span style="margin-left: 10px; color: #999;">(仅第一阶段使用；最多取多少个缓存候选节点进入启动前快速复检)</span>
        </a-form-item>

        <a-form-item label="启动前复检样本数" :label-col="labelCol" :wrapper-col="wrapperCol">
          <a-input-number v-model="bootstrapProbeSamples" :min="1" :max="20" />
          <span style="margin-left: 10px; color: #999;">(仅第一阶段使用；每批需要多少个样本才算完成，默认 2)</span>
        </a-form-item>

        <a-form-item label="国家/地区筛选" :label-col="labelCol" :wrapper-col="wrapperCol">
          <a-input
            v-model="allowedCountriesText"
            placeholder="例如 SG, !JP"
          />
          <span style="margin-left: 10px; color: #999;">(留空表示不限制；支持 !JP 这种排除写法)</span>
        </a-form-item>

        <a-form-item label="节点提供方筛选" :label-col="labelCol" :wrapper-col="wrapperCol">
          <a-input
            v-model="allowedOwnersText"
            placeholder="例如 amazon, !cloudflare"
          />
          <span style="margin-left: 10px; color: #999;">(仅第一阶段使用；按 owner 包含匹配，大小写不敏感，支持 !cloudflare 这种排除写法)</span>
        </a-form-item>

        <a-form-item label="最大延迟" :label-col="labelCol" :wrapper-col="wrapperCol">
          <a-input-number v-model="maxDelayMs" :min="0" :max="100000" />
          <span style="margin-left: 10px; color: #999;">(毫秒；0 表示不限制，仅对已缓存节点生效)</span>
        </a-form-item>

        <a-form-item label="订阅抓取低水位" :label-col="labelCol" :wrapper-col="wrapperCol">
          <a-input-number v-model="subscriptionSyncLowWatermark" :min="0" :max="10000000" />
          <span style="margin-left: 10px; color: #999;">(仅第二阶段使用；有效缓存数达到该值时跳过远端订阅抓取，0 表示始终抓取)</span>
        </a-form-item>

        <a-form-item label="启用缓存周期探测" :label-col="labelCol" :wrapper-col="wrapperCol">
          <a-checkbox v-model="cacheRefreshEnabled">
            启用第三阶段后台周期探测与回填
          </a-checkbox>
        </a-form-item>

        <a-form-item label="缓存周期刷新间隔" :label-col="labelCol" :wrapper-col="wrapperCol">
          <a-input-number v-model="cacheRefreshInterval" :min="1" :max="86400" :disabled="!cacheRefreshEnabled" />
          <span style="margin-left: 10px; color: #999;">(秒；仅第三阶段使用，周期性重检整个缓存文件，默认 21600 秒即 6 小时)</span>
        </a-form-item>

        <a-form-item label="批次探测超时" :label-col="labelCol" :wrapper-col="wrapperCol">
          <a-input-number v-model="cacheBatchTimeout" :min="15" :max="3600" :disabled="!cacheRefreshEnabled" />
          <span style="margin-left: 10px; color: #999;">(秒；仅第三阶段使用。每批最多检测一批缓存节点，超时后继续下一批)</span>
        </a-form-item>

        <a-form-item label="缓存探测样本数" :label-col="labelCol" :wrapper-col="wrapperCol">
          <a-input-number v-model="cacheRefreshProbeSamples" :min="1" :max="10" :disabled="!cacheRefreshEnabled" />
          <span style="margin-left: 10px; color: #999;">(仅第三阶段使用；每批需要多少个样本才算完成，默认 2)</span>
        </a-form-item>

        <a-form-item label="缓存批次大小" :label-col="labelCol" :wrapper-col="wrapperCol">
          <a-input-number v-model="cacheRefreshBatchSize" :min="1" :max="2000" :disabled="!cacheRefreshEnabled" />
          <span style="margin-left: 10px; color: #999;">(仅第三阶段使用；每批探测多少个缓存节点，默认 31。过大的批次会把 burst observatory 压成整批失败)</span>
        </a-form-item>

        <a-form-item label="订阅链接" :label-col="labelCol" :wrapper-col="wrapperCol">
          <a-textarea
            v-model="subscriptionsText"
            placeholder="每行一个订阅地址 (http/https)"
            :auto-size="{ minRows: 2, maxRows: 6 }"
          />
        </a-form-item>

        <a-form-item label="手动节点" :label-col="labelCol" :wrapper-col="wrapperCol">
          <a-textarea
            v-model="nodesText"
            placeholder="每行一个节点分享链接 (vmess://, vless://, trojan://, ss://)"
            :auto-size="{ minRows: 2, maxRows: 6 }"
          />
        </a-form-item>

        <a-form-item label="路由规则" :label-col="labelCol" :wrapper-col="wrapperCol">
          <div>
            <div style="margin-bottom: 5px; color: #999;">
              指定域名走 Xray 代理 (自动注入拦截规则)
            </div>
            <a-row v-for="(item, index) of rules" :key="index" :gutter="10" style="margin-bottom: 5px;">
              <a-col :span="14">
                <a-input v-model="item.domain" placeholder="域名 (e.g. openai.com)" />
              </a-col>
              <a-col :span="8">
                <a-select v-model="item.outboundTag" placeholder="Outbound" style="width: 100%">
                  <a-select-option value="balancer-proxy">
                    Proxy (Auto)
                  </a-select-option>
                  <a-select-option value="direct">
                    Direct
                  </a-select-option>
                  <a-select-option value="block">
                    Block
                  </a-select-option>
                </a-select>
              </a-col>
              <a-col :span="2">
                <a-button type="danger" icon="minus" @click="delRule(index)" />
              </a-col>
            </a-row>
            <a-button type="dashed" icon="plus" block @click="addRule">
              添加规则
            </a-button>
          </div>
        </a-form-item>

        <a-form-item label="测速地址" :label-col="labelCol" :wrapper-col="wrapperCol">
          <a-input v-model="config.plugin.xray.probeUrl" />
        </a-form-item>
      </a-form>
    </div>

    <template slot="footer">
      <div class="footer-bar">
        <a-button :loading="resetDefaultLoading" class="mr10" icon="sync" @click="resetDefault()">
          恢复默认
        </a-button>
        <a-button :loading="applyLoading" icon="check" type="primary" @click="apply()">
          应用
        </a-button>
      </div>
    </template>
  </ds-container>
</template>
