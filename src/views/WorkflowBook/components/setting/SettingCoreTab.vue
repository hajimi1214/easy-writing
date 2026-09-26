<template>
  <div class="setting-core-grid">
    <SettingSectionCard icon="fa-solid fa-spa" title="修炼体系" size="half">
      <WorkflowInlineEdit
        class="setting-core-intro"
        block
        multiline
        :rows="2"
        :model-value="core.cultivation.intro"
        @update:model-value="patchCore({ cultivation: { ...core.cultivation, intro: $event } })"
      />
      <ol class="setting-realm-ladder">
        <li v-for="(realm, index) in core.cultivation.realms" :key="index">
          <span class="setting-realm-dot" aria-hidden="true"></span>
          <strong>{{ realm.name }}</strong>
          <WorkflowInlineEdit
            block
            multiline
            :rows="2"
            :model-value="realm.desc"
            @update:model-value="updateRealm(index, $event)"
          />
        </li>
        <li class="setting-realm-more">
          <span class="setting-realm-dot is-muted" aria-hidden="true"></span>
          <strong>……</strong>
          <WorkflowInlineEdit
            block
            multiline
            :rows="2"
            :model-value="core.cultivation.more"
            @update:model-value="patchCore({ cultivation: { ...core.cultivation, more: $event } })"
          />
        </li>
      </ol>
    </SettingSectionCard>

    <SettingSectionCard icon="fa-solid fa-bolt" title="能力体系" size="half">
      <WorkflowInlineEdit
        class="setting-core-intro"
        block
        multiline
        :rows="2"
        :model-value="core.ability.intro"
        @update:model-value="patchCore({ ability: { ...core.ability, intro: $event } })"
      />
      <div class="setting-ability-row">
        <div v-for="key in abilityKeys" :key="key" class="setting-ability-item">
          <span class="setting-mini-icon"><i :class="core.ability[key].icon"></i></span>
          <div>
            <strong>{{ core.ability[key].title }}</strong>
            <WorkflowInlineEdit
              block
              multiline
              :rows="2"
              :model-value="core.ability[key].desc"
              @update:model-value="updateAbility(key, $event)"
            />
          </div>
        </div>
      </div>
      <div class="setting-dimension-row">
        <span class="setting-dimension-label">能力维度：</span>
        <span v-for="dim in core.ability.dimensions" :key="dim" class="setting-tag">{{ dim }}</span>
      </div>
    </SettingSectionCard>

    <SettingSectionCard icon="fa-solid fa-gears" title="特殊规则 / 世界机制" size="full">
      <WorkflowInlineEdit
        class="setting-core-intro"
        block
        multiline
        :rows="2"
        :model-value="core.mechanics.intro"
        @update:model-value="patchCore({ mechanics: { ...core.mechanics, intro: $event } })"
      />
      <div class="setting-mechanic-grid">
        <div v-for="(item, index) in core.mechanics.items" :key="index" class="setting-mechanic-item">
          <span class="setting-mini-icon"><i :class="item.icon"></i></span>
          <div>
            <strong>{{ item.title }}</strong>
            <WorkflowInlineEdit
              block
              multiline
              :rows="2"
              :model-value="item.desc"
              @update:model-value="updateMechanic(index, $event)"
            />
          </div>
        </div>
      </div>
    </SettingSectionCard>

    <SettingSectionCard icon="fa-solid fa-cubes-stacked" title="资源体系 / 门槛设定" size="full">
      <WorkflowInlineEdit
        class="setting-core-intro"
        block
        multiline
        :rows="2"
        :model-value="core.resources.intro"
        @update:model-value="patchCore({ resources: { ...core.resources, intro: $event } })"
      />
      <div class="setting-resource-row">
        <div v-for="(item, index) in core.resources.items" :key="index" class="setting-resource-item">
          <span class="setting-mini-icon"><i :class="item.icon"></i></span>
          <strong>{{ item.title }}</strong>
          <WorkflowInlineEdit
            block
            multiline
            :rows="3"
            :model-value="item.desc"
            @update:model-value="updateResource(index, $event)"
          />
        </div>
      </div>
    </SettingSectionCard>
  </div>
</template>

<script setup lang="ts">
import WorkflowInlineEdit from '../WorkflowInlineEdit.vue'
import SettingSectionCard from './SettingSectionCard.vue'
import type { WorkflowSettingCore } from '../../types'

const props = defineProps<{ core: WorkflowSettingCore }>()
const emit = defineEmits<{ (event: 'update', core: WorkflowSettingCore): void }>()

const abilityKeys = ['innate', 'acquired', 'bodyMemory', 'sealArt'] as const

const patchCore = (payload: Partial<WorkflowSettingCore>) => {
  emit('update', { ...props.core, ...payload })
}

const updateRealm = (index: number, desc: string) => {
  const realms = props.core.cultivation.realms.map((item, i) => (i === index ? { ...item, desc } : item))
  patchCore({ cultivation: { ...props.core.cultivation, realms } })
}

const updateAbility = (key: (typeof abilityKeys)[number], desc: string) => {
  patchCore({ ability: { ...props.core.ability, [key]: { ...props.core.ability[key], desc } } })
}

const updateMechanic = (index: number, desc: string) => {
  const items = props.core.mechanics.items.map((item, i) => (i === index ? { ...item, desc } : item))
  patchCore({ mechanics: { ...props.core.mechanics, items } })
}

const updateResource = (index: number, desc: string) => {
  const items = props.core.resources.items.map((item, i) => (i === index ? { ...item, desc } : item))
  patchCore({ resources: { ...props.core.resources, items } })
}
</script>
