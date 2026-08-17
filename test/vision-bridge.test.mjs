import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import AttachmentStore from '@deepseek-ai/dsh-attachment'
import LlmRuntime, {
  LlmAdapter,
  contentHasImage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'

import {
  DEFAULT_BRIDGE_PROVIDER,
  FileVisionAttemptStore,
  VISION_ANALYZE_TOOL,
  VisionBridgeAdapter,
  applyVisionBridge,
  decodeBridgeModelId,
  encodeBridgeModelId,
  imageInventoryEntries,
  resolveBridgeConfig,
} from '../lib/vision-bridge.mjs'

const BRIDGE_MODEL = encodeBridgeModelId(
  { provider: 'main-provider', model: 'main-model' },
  'vision-model',
)

function textScript(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

class RecordingAdapter extends LlmAdapter {
  constructor({ inputModalities, script, model = 'model', name = model } = {}) {
    super()
    this.inputModalities = inputModalities
    this.script = script ?? textScript(`${name} answer`)
    this.model = model
    this.name = name
    this.calls = []
  }

  listModels(provider) {
    return Promise.resolve([{
      provider,
      id: this.model,
      name: this.name,
      inputModalities: this.inputModalities,
    }])
  }

  resolveModel(provider, model) {
    return Promise.resolve({
      provider,
      id: model,
      name: model === this.model ? this.name : model,
      inputModalities: this.inputModalities,
      context: { contextWindow: 32_000 },
    })
  }

  async * stream(options) {
    this.calls.push(options)
    yield * this.script
  }
}

const TEST_IMAGE_LIMITS = Object.freeze({
  maxImageBytes: 5 * 1024 * 1024,
  maxImagesPerMessage: 20,
  maxMessageImageBytes: 20 * 1024 * 1024,
  maxImagePixels: 20_000_000,
  mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
})

class TestAttachmentStore extends AttachmentStore {
  imageLimits = TEST_IMAGE_LIMITS

  validateImage() { return Promise.resolve() }

  saveImage() { return Promise.reject(new Error('unused')) }

  readImage() { return Promise.reject(new Error('unused')) }
}

const image = {
  type: 'image',
  attachment: {
    attachmentId: 'sha256:test-image',
    mediaType: 'image/png',
    bytes: 68,
    width: 1,
    height: 1,
    name: 'error.png',
  },
}

function prompt(content) {
  return createUserMessage({ source: { kind: 'user' }, content })
}

async function collect(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

function testSession(id = 'session-1') {
  const events = []
  return {
    id,
    events,
    deriveMessages() {
      return events.flatMap(event => {
        if (event.type === 'user/message') return [event.data]
        if (event.type === 'tool/result') return [event.data.message]
        return []
      })
    },
    append(type, data, options = {}) {
      const event = { type, seq: events.length, time: Date.now(), data, ...options }
      events.push(event)
      return event
    },
  }
}

function bridgeHost(ctx, session = testSession()) {
  const definitions = new Map()
  const tools = {
    register(definition) {
      definitions.set(definition.name, definition)
      return () => { definitions.delete(definition.name) }
    },
  }
  const sessions = { get: id => String(id) === String(session.id) ? session : undefined }
  return {
    host: {
      llm: ctx.llm,
      get: service => service === 'attachments'
        ? { imageLimits: TEST_IMAGE_LIMITS }
        : service === 'tools' ? tools
          : service === 'sessions' ? sessions : undefined,
    },
    session,
    definitions,
  }
}

async function harness({
  mainModalities = ['text'],
  visionScript = textScript('OCR: connection refused'),
  bridgeConfig = {},
  session: evidenceSession = testSession(),
} = {}) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  const main = new RecordingAdapter({ inputModalities: mainModalities, script: textScript('main answer') })
  const vision = new RecordingAdapter({ inputModalities: ['text', 'image'], script: visionScript })
  ctx.llm.registerAdapter(['main-provider'], main)
  ctx.llm.registerAdapter(['vision-provider'], vision)
  const { host, session, definitions } = bridgeHost(ctx, evidenceSession)
  const bridge = applyVisionBridge(host, {
    ...bridgeConfig,
    visionModels: [{
      id: 'vision-model',
      name: 'Vision Model',
      provider: 'vision-provider',
      model: 'vision-model',
    }],
  })
  return { ctx, main, vision, bridge, session, definitions }
}

test('registers a composite route that advertises native image admission', async () => {
  const { ctx, definitions } = await harness()
  try {
    const providers = ctx.llm.listProviders()
    assert.ok(providers.some(provider => provider.id === DEFAULT_BRIDGE_PROVIDER))
    const model = await ctx.llm.resolveModelInfo(DEFAULT_BRIDGE_PROVIDER, BRIDGE_MODEL)
    assert.deepEqual(model.inputModalities, ['text', 'image'])
    assert.deepEqual(model.context, { contextWindow: 32_000 })
    assert.equal(model.defaultMaxTokens, undefined)
    const tool = definitions.get(VISION_ANALYZE_TOOL)
    assert.ok(tool)
    assert.match(tool.description, /Do not call this tool for image counts/)
    assert.deepEqual(tool.parameters.required, ['image_ids', 'instruction'])
  } finally {
    await ctx.fiber.dispose()
  }
})

test('reads image limits from the Cordis-injected attachment scope', async () => {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(TestAttachmentStore)
  const main = new RecordingAdapter({ inputModalities: ['text'], script: textScript('main answer') })
  const vision = new RecordingAdapter({ inputModalities: ['text', 'image'], script: textScript('vision answer') })
  const session = testSession()
  ctx.llm.registerAdapter(['main-provider'], main)
  ctx.llm.registerAdapter(['vision-provider'], vision)
  ctx.provide('tools', { register: () => () => {} })
  ctx.provide('sessions', { get: id => String(id) === session.id ? session : undefined })
  ctx.inject(['llm', 'attachments', 'tools', 'sessions'], (bridgeCtx) => {
    applyVisionBridge(bridgeCtx, {
      visionModels: [{
        id: 'vision-model',
        provider: 'vision-provider',
        model: 'vision-model',
      }],
    })
  })
  await new Promise(resolve => setImmediate(resolve))
  try {
    const chunks = await collect(ctx.llm.stream({
      provider: DEFAULT_BRIDGE_PROVIDER,
      model: BRIDGE_MODEL,
      messages: [
        prompt([image]),
        prompt([{ type: 'text', text: '现在的情况说明下' }]),
      ],
      sessionId: 'session-1',
    }))
    assert.deepEqual(chunks, textScript('main answer'))
    assert.equal(main.calls.length, 1)
    assert.equal(vision.calls.length, 0)
  } finally {
    await ctx.fiber.dispose()
  }
})

test('runs vision first and delegates image-free evidence to a text-only main route', async () => {
  const { ctx, main, vision, bridge, session } = await harness()
  try {
    const original = prompt([{ type: 'text', text: '这个截图为什么失败？' }, image])
    const chunks = await collect(ctx.llm.stream({
      provider: DEFAULT_BRIDGE_PROVIDER,
      model: BRIDGE_MODEL,
      messages: [original],
      sessionId: 'session-1',
    }))

    assert.deepEqual(chunks, textScript('main answer'))
    assert.equal(vision.calls.length, 1)
    assert.equal(main.calls.length, 1)
    assert.equal(vision.calls[0].messages.some(message => contentHasImage(message.content)), true)
    assert.equal(main.calls[0].messages.some(message => contentHasImage(message.content)), false)
    const mainText = main.calls[0].messages
      .flatMap(message => message.content)
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')
    assert.match(mainText, /OCR: connection refused/)
    assert.match(mainText, /trust="untrusted"/)
    assert.equal(contentHasImage(original.content), true)
    assert.equal(session.events.length, 2)
    assert.equal(session.events[0].type, 'user/message')
    assert.equal(session.events[0].data.source.kind, 'plugin')
    assert.equal(session.events[0].data.source.form, 'notice')
    assert.equal(session.events[0].data.source.visionBridge.state, 'ready')
    assert.equal(session.events[1].data.source.visionBridgeManifest.version, 1)
    assert.ok(main.calls[0].messages.some(message => message.id === session.events[0].data.id))

    await collect(bridge.stream({
      provider: DEFAULT_BRIDGE_PROVIDER,
      model: BRIDGE_MODEL,
      messages: [original],
      sessionId: 'session-1',
    }))
    assert.equal(vision.calls.length, 1)
    assert.equal(main.calls.length, 2)
    assert.equal(session.events.length, 2)

    const resumed = new VisionBridgeAdapter({
      llm: ctx.llm,
      get: service => service === 'attachments'
        ? { imageLimits: TEST_IMAGE_LIMITS }
        : service === 'sessions' ? { get: () => session } : undefined,
    }, bridge.config)
    await collect(resumed.stream({
      provider: DEFAULT_BRIDGE_PROVIDER,
      model: BRIDGE_MODEL,
      messages: [original, ...session.events.map(event => event.data)],
      sessionId: 'session-1',
    }))
    assert.equal(vision.calls.length, 1)
    assert.equal(session.events.length, 2)
  } finally {
    await ctx.fiber.dispose()
  }
})

test('reuses evidence for ordinary follow-ups and refreshes only through structured tool arguments', async () => {
  const session = testSession()
  const original = prompt([{ type: 'text', text: '这个图片是哪个角色？' }, image])
  session.append('user/message', original)
  const { ctx, main, vision, bridge, definitions } = await harness({ session })
  try {
    await collect(bridge.stream({
      provider: DEFAULT_BRIDGE_PROVIDER,
      model: BRIDGE_MODEL,
      messages: session.deriveMessages(),
      sessionId: 'session-1',
    }))
    assert.equal(vision.calls.length, 1)

    const followup = prompt([{ type: 'text', text: '上一张截图是什么角色？' }])
    session.append('user/message', followup)
    await collect(bridge.stream({
      provider: DEFAULT_BRIDGE_PROVIDER,
      model: BRIDGE_MODEL,
      messages: session.deriveMessages(),
      sessionId: 'session-1',
    }))
    assert.equal(vision.calls.length, 1)
    assert.equal(main.calls.length, 2)

    const tool = definitions.get(VISION_ANALYZE_TOOL)
    assert.ok(tool)
    const reusedContexts = []
    const reused = await tool.execute({
      image_ids: ['sha256:test-image'],
      instruction: '确认角色身份',
      refresh: false,
    }, {
      agent: { session },
      callId: 'reuse-call',
      signal: new AbortController().signal,
      deferContext: message => { reusedContexts.push(message) },
    })
    assert.match(reused, /reused/)
    assert.equal(reusedContexts.length, 0)
    assert.equal(vision.calls.length, 1)

    const refreshedContexts = []
    const refreshed = await tool.execute({
      image_ids: ['sha256:test-image'],
      instruction: '重新检查角色身份和服装细节',
      refresh: true,
    }, {
      agent: { session },
      callId: 'refresh-call',
      signal: new AbortController().signal,
      deferContext: message => { refreshedContexts.push(message) },
    })
    assert.match(refreshed, /analyzed/)
    assert.equal(vision.calls.length, 2)
    assert.equal(refreshedContexts.length, 1)
    assert.equal(refreshedContexts[0].source.visionBridge.requestMessageId, 'tool:refresh-call')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('does not spend a vision call for a text-only turn', async () => {
  const { ctx, main, vision } = await harness()
  try {
    await collect(ctx.llm.stream({
      provider: DEFAULT_BRIDGE_PROVIDER,
      model: BRIDGE_MODEL,
      messages: [prompt([{ type: 'text', text: '普通文字问题' }])],
    }))
    assert.equal(vision.calls.length, 0)
    assert.equal(main.calls.length, 1)
  } finally {
    await ctx.fiber.dispose()
  }
})

test('passes native images directly when the configured main route supports vision', async () => {
  const { ctx, main, vision } = await harness({ mainModalities: ['text', 'image'] })
  try {
    await collect(ctx.llm.stream({
      provider: DEFAULT_BRIDGE_PROVIDER,
      model: BRIDGE_MODEL,
      messages: [prompt([{ type: 'text', text: '直接看图' }, image])],
      sessionId: 'session-1',
    }))
    assert.equal(vision.calls.length, 0)
    assert.equal(main.calls.length, 1)
    assert.equal(main.calls[0].messages.some(message => contentHasImage(message.content)), true)
  } finally {
    await ctx.fiber.dispose()
  }
})

test('blocks the main route when vision fails', async () => {
  const failure = {
    type: 'finish',
    reason: {
      kind: 'error',
      failure: { message: 'vision unavailable', code: 'VISION_DOWN' },
    },
  }
  const session = testSession()
  const original = prompt([image])
  session.append('user/message', original)
  const { ctx, main, vision, definitions } = await harness({ visionScript: [failure], session })
  try {
    const messages = session.deriveMessages()
    const chunks = await collect(ctx.llm.stream({
      provider: DEFAULT_BRIDGE_PROVIDER,
      model: BRIDGE_MODEL,
      messages,
      sessionId: 'session-1',
    }))
    assert.deepEqual(chunks, [failure])
    assert.equal(main.calls.length, 0)

    const repeated = await collect(ctx.llm.stream({
      provider: DEFAULT_BRIDGE_PROVIDER,
      model: BRIDGE_MODEL,
      messages,
      sessionId: 'session-1',
    }))
    assert.equal(repeated.at(-1)?.reason.failure?.code, 'VISION_RETRY_REQUIRED')
    assert.equal(vision.calls.length, 1)

    const tool = definitions.get(VISION_ANALYZE_TOOL)
    await assert.rejects(tool.execute({
      image_ids: ['sha256:test-image'],
      instruction: 'retry after the failed provider call',
      refresh: true,
    }, {
      agent: { session },
      callId: 'retry-call',
      signal: new AbortController().signal,
      deferContext: () => {},
    }), error => error.code === 'VISION_DOWN' || /vision unavailable/.test(error.message))
    assert.equal(vision.calls.length, 2)

    await collect(ctx.llm.stream({
      provider: DEFAULT_BRIDGE_PROVIDER,
      model: BRIDGE_MODEL,
      messages: [prompt([image])],
      sessionId: 'session-1',
    }))
    assert.equal(vision.calls.length, 2)
  } finally {
    await ctx.fiber.dispose()
  }
})

test('rejects recursive vision targets and duplicate vision candidates before registration', () => {
  assert.deepEqual(resolveBridgeConfig({}).visionModels, [])
  assert.equal(resolveBridgeConfig({ visionModels: [] }).discoverVisionModels, true)
  assert.throws(() => resolveBridgeConfig({
    discoverVisionModels: false,
    visionModels: [],
  }), /requires discovery or at least one explicitly configured vision model/)
  assert.throws(() => resolveBridgeConfig({ discoverVisionModels: 'yes' }), /must be a boolean/)

  assert.throws(() => resolveBridgeConfig({
    visionModels: [{
      id: 'recursive',
      provider: DEFAULT_BRIDGE_PROVIDER,
      model: 'recursive',
    }],
  }), /must not recurse/)

  assert.throws(() => new VisionBridgeAdapter({ llm: {} }, {
    visionModels: [
      {
        id: 'duplicate',
        provider: 'vision-provider',
        model: 'one',
      },
      {
        id: 'duplicate',
        provider: 'vision-provider',
        model: 'two',
      },
    ],
  }), /duplicate vision model id/)
})

test('keeps dynamic bridge routes out of the global catalog and preserves their main metadata', async () => {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  ctx.provide('tools', { register: () => () => {} })
  ctx.llm.registerAdapter(['main-a'], new RecordingAdapter({
    inputModalities: ['text'],
    model: 'reasoner-a',
    name: 'Reasoner A',
  }))
  ctx.llm.registerAdapter(['main-b'], new RecordingAdapter({
    inputModalities: ['text'],
    model: 'reasoner-b',
    name: 'Reasoner B',
  }))
  ctx.llm.registerAdapter(['vision-a'], new RecordingAdapter({
    inputModalities: ['text', 'image'],
    model: 'reader-a',
    name: 'Reader A',
  }))
  ctx.llm.registerAdapter(['vision-b'], new RecordingAdapter({
    inputModalities: ['text', 'image'],
    model: 'reader-b',
    name: 'Reader B',
  }))
  ctx.llm.registerAdapter(['vision-c'], new RecordingAdapter({
    inputModalities: ['text', 'image'],
    model: 'reader-c',
    name: 'Reader C',
  }))
  const bridge = applyVisionBridge(ctx, {
    visionModels: [
      {
        id: 'reader-b',
        name: 'Reader B',
        provider: 'vision-b',
        model: 'reader-b',
      },
      {
        id: 'reader-a',
        name: 'Reader A',
        provider: 'vision-a',
        model: 'reader-a',
      },
    ],
  })
  try {
    const aliases = await ctx.llm.listModels(DEFAULT_BRIDGE_PROVIDER)
    assert.deepEqual(aliases, [])
    const candidates = await bridge.visionCandidates()
    assert.deepEqual(candidates.map(candidate => candidate.name), ['Reader B', 'Reader A', 'Reader C'])
    assert.equal(candidates[2].providerName, 'vision-c')
    assert.equal(candidates[2].discovered, true)
    const dynamic = encodeBridgeModelId({ provider: 'main-a', model: 'reasoner-a' }, 'reader-b')
    assert.deepEqual(decodeBridgeModelId(dynamic), {
      main: { provider: 'main-a', model: 'reasoner-a' },
      visionId: 'reader-b',
    })
    const info = await ctx.llm.resolveModelInfo(DEFAULT_BRIDGE_PROVIDER, dynamic)
    assert.equal(info.name, 'Reasoner A · Vision via Reader B')
    assert.deepEqual(info.context, { contextWindow: 32_000 })
    assert.deepEqual(info.inputModalities, ['text', 'image'])
    const discovered = encodeBridgeModelId(
      { provider: 'main-a', model: 'reasoner-a' },
      candidates[2].id,
    )
    assert.equal((await ctx.llm.resolveModelInfo(DEFAULT_BRIDGE_PROVIDER, discovered)).name, 'Reasoner A · Vision via Reader C')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('does not semantically rescan unresolved historical images on an unrelated turn', async () => {
  const { ctx, main, vision } = await harness()
  try {
    await collect(ctx.llm.stream({
      provider: DEFAULT_BRIDGE_PROVIDER,
      model: BRIDGE_MODEL,
      messages: [
        prompt([{ type: 'text', text: '旧消息' }, image]),
        prompt([{ type: 'text', text: '现在只讨论文字，不需要看之前的附件。' }]),
      ],
      sessionId: 'session-1',
    }))
    assert.equal(vision.calls.length, 0)
    assert.equal(main.calls.length, 1)
    assert.equal(main.calls[0].messages.some(message => contentHasImage(message.content)), false)
  } finally {
    await ctx.fiber.dispose()
  }
})

test('injects an image inventory and leaves historical-image semantics to the main model', async () => {
  const { ctx, main, vision } = await harness()
  try {
    const chunks = await collect(ctx.llm.stream({
      provider: DEFAULT_BRIDGE_PROVIDER,
      model: BRIDGE_MODEL,
      messages: [
        prompt([{ type: 'text', text: '先保存这张图' }, image]),
        prompt([{ type: 'text', text: '请重新读取上一张截图，再判断原因。' }]),
      ],
      sessionId: 'session-1',
    }))
    assert.deepEqual(chunks, textScript('main answer'))
    assert.equal(vision.calls.length, 0)
    const text = main.calls[0].messages.flatMap(message => message.content)
      .filter(block => block.type === 'text').map(block => block.text).join('\n')
    assert.match(text, /vision-bridge-image-manifest/)
    assert.match(text, /id=sha256:test-image/)
    assert.match(text, new RegExp(VISION_ANALYZE_TOOL))
  } finally {
    await ctx.fiber.dispose()
  }
})

test('lets the main model select an exact historical image through the vision tool', async () => {
  const secondImage = {
    ...image,
    attachment: { ...image.attachment, attachmentId: 'sha256:second-image', name: 'second.png' },
  }
  const session = testSession()
  session.append('user/message', prompt([image]))
  session.append('user/message', prompt([secondImage]))
  session.append('user/message', prompt([{ type: 'text', text: '重新查看上面最近一次的截图内容' }]))
  const { ctx, vision, bridge, definitions } = await harness({ session })
  try {
    await collect(bridge.stream({
      provider: DEFAULT_BRIDGE_PROVIDER,
      model: BRIDGE_MODEL,
      messages: session.deriveMessages(),
      sessionId: 'session-1',
    }))
    assert.equal(vision.calls.length, 0)
    const deferred = []
    await definitions.get(VISION_ANALYZE_TOOL).execute({
      image_ids: ['sha256:second-image'],
      instruction: 'describe the most recent screenshot',
      refresh: false,
    }, {
      agent: { session },
      callId: 'select-second',
      signal: new AbortController().signal,
      deferContext: message => { deferred.push(message) },
    })
    assert.equal(vision.calls.length, 1)
    const selected = vision.calls[0].messages
      .flatMap(message => message.content)
      .filter(block => block.type === 'image')
      .map(block => block.attachment.attachmentId)
    assert.deepEqual(selected, ['sha256:second-image'])
    assert.equal(deferred.length, 1)
  } finally {
    await ctx.fiber.dispose()
  }
})

test('rejects unavailable or foreign manifest ids before any paid tool analysis', async () => {
  const legacyId = 'sha256:64aa236d000000000000000000000000'
  const session = testSession()
  session.append('user/message', prompt([{
    type: 'text',
    text: `![legacy](/describe-image/raw/${legacyId})`,
  }, image]))
  session.append('user/message', prompt([{ type: 'text', text: '检查历史图片' }]))
  const { ctx, vision, bridge, definitions } = await harness({ session })
  try {
    await collect(bridge.stream({
      provider: DEFAULT_BRIDGE_PROVIDER,
      model: BRIDGE_MODEL,
      messages: session.deriveMessages(),
      sessionId: 'session-1',
    }))
    const tool = definitions.get(VISION_ANALYZE_TOOL)
    const exec = {
      agent: { session },
      callId: 'invalid-target',
      signal: new AbortController().signal,
      deferContext: () => {},
    }
    await assert.rejects(
      tool.execute({ image_ids: [legacyId], instruction: 'read it' }, exec),
      error => error.code === 'VISION_TOOL_IMAGE_UNAVAILABLE',
    )
    await assert.rejects(
      tool.execute({ image_ids: ['sha256:not-in-session'], instruction: 'read it' }, exec),
      error => error.code === 'VISION_TOOL_IMAGE_NOT_FOUND',
    )
    assert.equal(vision.calls.length, 0)
  } finally {
    await ctx.fiber.dispose()
  }
})

test('passes ambiguous and metadata-only historical image requests to the main model without scanning', async () => {
  const secondImage = {
    ...image,
    attachment: { ...image.attachment, attachmentId: 'sha256:second-image', name: 'second.png' },
  }
  const { ctx, main, vision } = await harness()
  try {
    for (const text of ['请分析图片。', '先不用扫图，汇报下当前历史记录里你能找到的图片有几张。']) {
      const chunks = await collect(ctx.llm.stream({
        provider: DEFAULT_BRIDGE_PROVIDER,
        model: BRIDGE_MODEL,
        messages: [
          prompt([image]),
          prompt([secondImage]),
          prompt([{ type: 'text', text }]),
        ],
        sessionId: 'session-1',
      }))
      assert.deepEqual(chunks, textScript('main answer'))
    }
    assert.equal(vision.calls.length, 0)
    assert.equal(main.calls.length, 2)
    const latestText = main.calls[1].messages.flatMap(message => message.content)
      .filter(block => block.type === 'text').map(block => block.text).join('\n')
    assert.match(latestText, /#1.*sha256:test-image/)
    assert.match(latestText, /#2.*sha256:second-image/)
    assert.match(latestText, /without reading image pixels/)
  } finally {
    await ctx.fiber.dispose()
  }
})

test('inventories legacy markdown references alongside native image blocks', () => {
  const secondImage = {
    ...image,
    attachment: { ...image.attachment, attachmentId: 'sha256:second-image', name: 'second.png' },
  }
  const legacy = [
    '![图片](/describe-image/raw/sha256:64aa236d000000000000000000000000)',
    '![selector](/describe-image/raw/sha256:e2226e79000000000000000000000000)',
    '![panel](/describe-image/raw/sha256:904612ce000000000000000000000000)',
  ].join('\n')
  const inventory = imageInventoryEntries([
    prompt([{ type: 'text', text: legacy }]),
    prompt([image]),
    prompt([secondImage]),
  ])
  assert.equal(inventory.length, 5)
  assert.deepEqual(inventory.map(entry => entry.kind), [
    'markdown', 'markdown', 'markdown', 'native', 'native',
  ])
})

test('persists successful image evidence individually and blocks main after a later image fails', async () => {
  const secondImage = {
    ...image,
    attachment: { ...image.attachment, attachmentId: 'sha256:second-image', name: 'second.png' },
  }
  const failure = {
    type: 'finish',
    reason: { kind: 'error', failure: { message: 'second image failed', code: 'VISION_DOWN' } },
  }
  const { ctx, main, vision, session } = await harness()
  vision.script = textScript('first image evidence')
  const originalStream = vision.stream.bind(vision)
  vision.stream = async function * (options) {
    if (this.calls.length === 1) {
      this.calls.push(options)
      yield failure
      return
    }
    yield * originalStream(options)
  }
  try {
    const chunks = await collect(ctx.llm.stream({
      provider: DEFAULT_BRIDGE_PROVIDER,
      model: BRIDGE_MODEL,
      messages: [prompt([{ type: 'text', text: '比较两张截图' }, image, secondImage])],
      sessionId: 'session-1',
    }))
    assert.deepEqual(chunks, [failure])
    assert.equal(vision.calls.length, 2)
    assert.equal(session.events.length, 1)
    assert.equal(session.events[0].data.source.visionBridge.attachmentId, 'sha256:test-image')
    assert.equal(main.calls.length, 0)
  } finally {
    await ctx.fiber.dispose()
  }
})

test('enforces a configurable per-turn description limit before any paid vision call', async () => {
  const secondImage = {
    ...image,
    attachment: { ...image.attachment, attachmentId: 'sha256:second-image', name: 'second.png' },
  }
  const { ctx, main, vision } = await harness({ bridgeConfig: { maxImagesPerTurn: 1 } })
  try {
    const chunks = await collect(ctx.llm.stream({
      provider: DEFAULT_BRIDGE_PROVIDER,
      model: BRIDGE_MODEL,
      messages: [prompt([image, secondImage])],
      sessionId: 'session-1',
    }))
    assert.equal(chunks.at(-1)?.reason.failure?.code, 'VISION_TOO_MANY_IMAGES')
    assert.equal(vision.calls.length, 0)
    assert.equal(main.calls.length, 0)
  } finally {
    await ctx.fiber.dispose()
  }
})

test('shares one paid vision attempt across concurrent requests for the same evidence key', async () => {
  const { ctx, main, vision, bridge, session } = await harness()
  let release
  const gate = new Promise(resolve => { release = resolve })
  vision.stream = async function * (options) {
    this.calls.push(options)
    await gate
    yield * textScript('shared evidence')
  }
  try {
    const options = {
      provider: DEFAULT_BRIDGE_PROVIDER,
      model: BRIDGE_MODEL,
      messages: [prompt([{ type: 'text', text: '读取这张截图' }, image])],
      sessionId: 'session-1',
    }
    const first = collect(bridge.stream(options))
    const second = collect(bridge.stream(options))
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(vision.calls.length, 1)
    release()
    await Promise.all([first, second])
    assert.equal(vision.calls.length, 1)
    assert.equal(session.events.length, 2)
    assert.equal(main.calls.length, 2)
  } finally {
    await ctx.fiber.dispose()
  }
})

test('durable attempt markers turn an interrupted previous process into outcome-unknown', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-vision-attempts-'))
  const sessionId = 'session-state-test'
  const key = 'evidence-key'
  try {
    const first = new FileVisionAttemptStore(root, 'process-a')
    const restarted = new FileVisionAttemptStore(root, 'process-b')
    assert.deepEqual(await first.begin(sessionId, key), { acquired: true })
    assert.deepEqual(await restarted.begin(sessionId, key), {
      acquired: false,
      state: 'outcome-unknown',
    })
    await first.settle(sessionId, key, 'failed')
    assert.deepEqual(await restarted.begin(sessionId, key), {
      acquired: false,
      state: 'failed',
    })
    await first.clear(sessionId, key)
    assert.deepEqual(await restarted.begin(sessionId, key), { acquired: true })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('classifies an aborted vision stream as canceled and does not repeat it automatically', async () => {
  const aborted = {
    type: 'finish',
    reason: { kind: 'aborted', failure: { message: 'user canceled', code: 'ABORTED' } },
  }
  const { ctx, main, vision } = await harness({ visionScript: [aborted] })
  const messages = [prompt([image])]
  try {
    assert.deepEqual(await collect(ctx.llm.stream({
      provider: DEFAULT_BRIDGE_PROVIDER,
      model: BRIDGE_MODEL,
      messages,
      sessionId: 'session-1',
    })), [aborted])
    const repeated = await collect(ctx.llm.stream({
      provider: DEFAULT_BRIDGE_PROVIDER,
      model: BRIDGE_MODEL,
      messages,
      sessionId: 'session-1',
    }))
    assert.equal(repeated.at(-1)?.reason.failure?.code, 'VISION_RETRY_REQUIRED')
    assert.equal(vision.calls.length, 1)
    assert.equal(main.calls.length, 0)
  } finally {
    await ctx.fiber.dispose()
  }
})

test('marks a completed vision call outcome-unknown when durable evidence append fails', async () => {
  const session = testSession()
  session.append = () => { throw new Error('persistence unavailable') }
  const { ctx, main, vision } = await harness({ session })
  const messages = [prompt([image])]
  try {
    const first = await collect(ctx.llm.stream({
      provider: DEFAULT_BRIDGE_PROVIDER,
      model: BRIDGE_MODEL,
      messages,
      sessionId: 'session-1',
    }))
    assert.equal(first.at(-1)?.reason.failure?.code, 'VISION_OUTCOME_UNKNOWN')
    const repeated = await collect(ctx.llm.stream({
      provider: DEFAULT_BRIDGE_PROVIDER,
      model: BRIDGE_MODEL,
      messages,
      sessionId: 'session-1',
    }))
    assert.equal(repeated.at(-1)?.reason.failure?.code, 'VISION_RETRY_REQUIRED')
    assert.equal(vision.calls.length, 1)
    assert.equal(main.calls.length, 0)
  } finally {
    await ctx.fiber.dispose()
  }
})
