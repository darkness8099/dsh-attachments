import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const clientPath = join(import.meta.dirname, '..', 'lib', 'client.js')

let registered
globalThis.window = {
  __ModuleLoader__: {
    load(row) {
      registered = row
    },
  },
}

await import(`${pathToFileURL(clientPath).href}?client-test=${Date.now()}`)
assert.equal(registered?.id, 'dsh-attachments')
const client = registered.factory((specifier) => {
  if (specifier === 'react') {
    return {
      memo: component => component,
      useCallback: () => { throw new Error('hook not exercised by bundle contract test') },
      useEffect: () => { throw new Error('hook not exercised by bundle contract test') },
      useRef: () => { throw new Error('hook not exercised by bundle contract test') },
      useState: () => { throw new Error('hook not exercised by bundle contract test') },
      useSyncExternalStore: () => { throw new Error('hook not exercised by bundle contract test') },
    }
  }
  if (specifier === 'react/jsx-runtime') {
    return {
      Fragment: Symbol.for('react.fragment'),
      jsx: () => { throw new Error('component rendering is outside this registry contract test') },
      jsxs: () => { throw new Error('component rendering is outside this registry contract test') },
    }
  }
  throw new Error(`unexpected browser external: ${specifier}`)
})

test('browser bundle partitions native images from generic attachment files', () => {
  const png = { name: 'whale.png', type: 'image/png' }
  const svg = { name: 'whale.svg', type: 'image/svg+xml' }
  const text = { name: 'notes.txt', type: 'text/plain' }
  const partition = client.internals.partitionDroppedFiles([png, svg, text])

  assert.deepEqual(partition.nativeImages, [png])
  assert.deepEqual(partition.genericFiles, [svg, text])
})

test('browser bundle registers input cards and history renderer through public slots', () => {
  const slots = []
  const definitions = []
  const effects = []
  const ctx = {
    effect(callback, label) {
      effects.push({ callback, label })
    },
    conversationEvents: {
      register(definition) {
        definitions.push(definition)
        return () => {}
      },
    },
    slots: {
      inject(name, mount) {
        slots.push({ kind: 'inject', name })
        mount()
        return () => {}
      },
      register(options, component) {
        slots.push({ kind: 'register', options, component })
        return () => {}
      },
    },
  }

  client.apply(ctx)

  assert.deepEqual(
    slots.filter(row => row.kind === 'register').map(row => row.options.name),
    ['conversation.chat.node', 'conversation.input.attachments', 'conversation.input.dock', 'conversation.input.right'],
  )
  assert.equal(definitions[0]?.kind, 'dsh-attachments')
  assert.match(effects[0]?.label, /styles/)
})

test('vision guidance lists configured vision candidates independently of the current main route', () => {
  const catalog = client.internals.parseBridgeCatalog({
    ok: true,
    provider: 'vision-bridge',
    providerName: 'Vision Bridge',
    main: { provider: 'main-a', model: 'reasoner', name: 'Main A' },
    required: true,
    active: false,
    visionModels: [
      {
        id: 'reader-1', name: 'Reader 1', model: 'dynamic-1', bridgeName: 'Main A · Vision via Reader 1',
        description: 'Reader 1 bridge',
      },
      {
        id: 'reader-2', name: 'Reader 2', model: 'dynamic-2', bridgeName: 'Main A · Vision via Reader 2',
        description: 'Reader 2 bridge',
      },
    ],
  })
  const candidates = client.internals.availableBridgeCandidates(catalog)

  assert.deepEqual(candidates.map(row => row.id), ['reader-1', 'reader-2'])
  assert.deepEqual(client.internals.groupBridgeCandidates([
    { ...candidates[0], group: 'Configured' },
    { ...candidates[1], group: 'OpenAI' },
  ]).map(([group, entries]) => [group, entries.map(entry => entry.id)]), [
    ['Configured', ['reader-1']],
    ['OpenAI', ['reader-2']],
  ])
  assert.deepEqual(client.internals.availableBridgeCandidates({ ...catalog, required: false }), [])
  assert.deepEqual(client.internals.parseBridgeCatalog({
    ok: true, provider: 'vision-bridge', providerName: 'Vision Bridge', main: null, visionModels: [{}],
  }).visionModels, [])
})

test('an active bridge collapses the guide into the compact vision control', () => {
  const active = {
    id: 'reader-1', name: 'Reader 1', model: 'dynamic-1', group: 'Configured',
    bridgeName: 'Main · Vision via Reader 1', description: 'Reader 1 bridge',
  }
  assert.equal(client.internals.shouldShowVisionGuide(false, false, active), false)
  assert.equal(client.internals.shouldShowVisionGuide(true, false, active), false)
  assert.equal(client.internals.shouldShowVisionGuide(true, false, undefined), true)
  assert.equal(client.internals.shouldShowVisionGuide(false, true, active), true)
  assert.equal(client.internals.shouldShowVisionControl(active, 2), true)
  assert.equal(client.internals.shouldShowVisionControl(active, 1), false)
})

test('active bridge label survives authoritative directory refresh and is removed after switching main', () => {
  const dynamicModel = 'session-v1.dynamic'
  const nativeGroups = [{
    id: 'main-a',
    name: 'Main Provider',
    models: [{ id: 'reasoner', name: 'Main A' }],
  }]
  let state = {
    current: { provider: 'vision-bridge', model: dynamicModel },
    groups: structuredClone(nativeGroups),
  }
  const directory = {
    store: {
      getSnapshot: () => state,
      update(mutator) {
        const next = structuredClone(state)
        mutator(next)
        state = next
      },
    },
  }
  const catalog = client.internals.parseBridgeCatalog({
    ok: true,
    provider: 'vision-bridge',
    providerName: 'Vision Bridge',
    main: { provider: 'main-a', model: 'reasoner', name: 'Main A' },
    required: true,
    active: true,
    visionModels: [{
      id: 'reader',
      name: 'Reader',
      model: dynamicModel,
      bridgeName: 'Main A · Vision via Reader',
      description: 'Reader bridge',
    }],
  })

  client.internals.syncActiveBridgeModel(directory, catalog)
  assert.deepEqual(state.groups.at(-1), {
    id: 'vision-bridge',
    name: 'Vision Bridge',
    models: [{
      id: dynamicModel,
      name: 'Main A · Vision via Reader',
      description: 'Reader bridge',
    }],
  })

  state = { ...state, groups: structuredClone(nativeGroups) }
  client.internals.syncActiveBridgeModel(directory, catalog)
  assert.equal(state.groups.some(group => group.id === 'vision-bridge'), true)

  state = {
    ...state,
    current: { provider: 'main-a', model: 'reasoner' },
  }
  client.internals.syncActiveBridgeModel(directory, catalog)
  assert.deepEqual(state.groups, nativeGroups)
})

test('model selection preflight offers a bridge for any text-only target when the session has images', async () => {
  const selected = []
  const offered = []
  const restored = []
  let cleared = 0
  let draftHasImages = false
  let preflight = client.internals.parseBridgeCatalog({
    ok: true,
    provider: 'vision-bridge',
    providerName: 'Vision Bridge',
    main: { provider: 'arbitrary-provider', model: 'text-model', name: 'Any Text Model' },
    required: true,
    active: false,
    sessionHasImages: true,
    visionModels: [{
      id: 'reader', name: 'Reader', model: 'dynamic-route',
      bridgeName: 'Any Text Model · Vision via Reader', description: 'Reader bridge',
    }],
  })
  let current = { provider: 'main-provider', model: 'main-model' }
  const originalSelect = async selection => { selected.push(selection); current = selection }
  const directory = {
    select: originalSelect,
    store: { getSnapshot: () => ({ current }) },
  }
  const installed = client.internals.installModelSelectionBridge(directory, {
    preflight: async () => preflight,
    draftHasImages: () => draftHasImages,
    offer: catalog => { offered.push(catalog) },
    clear: () => { cleared += 1 },
    bridgeSelected: async selection => { restored.push(selection) },
  })
  const target = { provider: 'arbitrary-provider', model: 'text-model' }

  await directory.select(target)
  assert.equal(selected.length, 0)
  assert.deepEqual(offered, [preflight])

  await installed.select({ provider: 'vision-bridge', model: 'dynamic-route' })
  assert.deepEqual(selected, [{ provider: 'vision-bridge', model: 'dynamic-route' }])
  assert.deepEqual(restored, [])

  const changedEffort = { provider: 'vision-bridge', model: 'dynamic-route', reasoningEffort: 'max' }
  await directory.select(changedEffort)
  assert.deepEqual(selected.at(-1), changedEffort)
  assert.deepEqual(restored, [changedEffort])

  preflight = { ...preflight, sessionHasImages: false }
  await directory.select(target)
  assert.deepEqual(selected.at(-1), target)

  draftHasImages = true
  await directory.select(target)
  assert.equal(offered.length, 2)

  draftHasImages = false
  preflight = { ...preflight, required: false, visionModels: [] }
  const nativeVision = { provider: 'vision-provider', model: 'vision-model' }
  await directory.select(nativeVision)
  assert.deepEqual(selected.at(-1), nativeVision)

  preflight = { ...preflight, required: true, sessionHasImages: true, visionModels: [] }
  const noCandidate = { provider: 'another-provider', model: 'text-model' }
  await directory.select(noCandidate)
  assert.deepEqual(selected.at(-1), noCandidate)
  assert.ok(cleared >= 3)

  installed.dispose()
  assert.equal(directory.select, originalSelect)
})

test('a dropped folder remains one logical attachment instead of one card per child', async () => {
  const text = { name: 'notes.txt', type: 'text/plain', size: 5, webkitRelativePath: '' }
  const image = { name: 'whale.png', type: 'image/png', size: 8, webkitRelativePath: '' }
  const fileEntry = file => ({
    isFile: true,
    isDirectory: false,
    name: file.name,
    file(resolve) { resolve(file) },
  })
  const directoryEntry = (name, batches) => ({
    isFile: false,
    isDirectory: true,
    name,
    createReader() {
      let index = 0
      return {
        readEntries(resolve) { resolve(batches[index++] ?? []) },
      }
    },
  })
  const nested = directoryEntry('assets', [[fileEntry(image)], []])
  const root = directoryEntry('project', [[fileEntry(text)], [nested], []])

  const collected = await client.internals.collectDrop([{ entry: root, file: null }])

  assert.equal(collected.errors.length, 0)
  assert.equal(collected.sources.length, 1)
  assert.equal(collected.sources[0].kind, 'directory')
  assert.equal(collected.sources[0].name, 'project')
  assert.equal(collected.sources[0].entry, root)

  const members = await client.internals.directoryMembers(root)

  assert.deepEqual(members.map(row => [row.kind, row.path]), [
    ['file', 'notes.txt'],
    ['directory', 'assets'],
    ['file', 'assets/whale.png'],
  ])
  assert.deepEqual(members.filter(row => row.kind === 'file').map(row => row.file), [text, image])
})

test('the plugin owns directory and generic-file drops but leaves direct native images to Harness', () => {
  const directory = { isDirectory: true, isFile: false, name: 'project' }
  const png = { name: 'whale.png', type: 'image/png' }
  const text = { name: 'notes.txt', type: 'text/plain' }

  assert.equal(client.internals.pluginOwnsDrop([{ entry: directory, file: null }]), true)
  assert.equal(client.internals.pluginOwnsDrop([{ entry: null, file: text }]), true)
  assert.equal(client.internals.pluginOwnsDrop([{ entry: null, file: png }]), false)
})

test('history definition projects durable attachment metadata into a chat node', () => {
  const file = {
    id: '22df9452-b27e-4ca5-a6a6-69bb99b95fee',
    kind: 'file',
    name: 'notes.txt',
    mediaType: 'text/plain',
    size: 12,
    path: '.deepseek-harness/attachments/22df9452-notes.txt',
  }
  const event = {
    type: 'user/message',
    seq: 7,
    time: 123,
    data: {
      id: 'message-1',
      source: { kind: 'user', dshAttachments: [file] },
    },
  }
  const definition = client.internals.attachmentDefinition
  const match = definition.match(event)
  assert.deepEqual(match, { id: 'message-1', role: 'start' })

  const state = definition.start({}, { ...match, event })
  const node = definition.buildViewNode({
    key: 'dsh-attachments:message-1',
    id: 'message-1',
    state,
    start: { location: { kind: 'turn', turn: 1 } },
  })
  assert.equal(node.kind, 'dsh-attachments')
  assert.equal(node.anchorSeq, 7.01)
  assert.deepEqual(node.data.files, [file])
})
