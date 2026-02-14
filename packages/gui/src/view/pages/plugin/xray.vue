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
      // Deep copy rules
      this.rules = JSON.parse(JSON.stringify(this.config.plugin.xray.rules || []))
    },
    async applyBefore () {
      // Sync local data to config
      this.config.plugin.xray.subscriptions = this.subscriptionsText.split('\n').map(s => s.trim()).filter(s => s)
      this.config.plugin.xray.nodes = this.nodesText.split('\n').map(s => s.trim()).filter(s => s)
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

        <a-form-item label="Xray 路径" :label-col="labelCol" :wrapper-col="wrapperCol">
          <a-input v-model="config.plugin.xray.binPath" placeholder="Xray 可执行文件的绝对路径" />
        </a-form-item>

        <a-form-item label="监听端口" :label-col="labelCol" :wrapper-col="wrapperCol">
          <a-input-number v-model="config.plugin.xray.localPort" :min="0" :max="65535" />
          <span style="margin-left: 10px; color: #999;">(0 表示自动选择可用端口；非 0 则强制使用该端口，占用会报错)</span>
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