import assert from 'node:assert/strict'
import { Readable, Writable } from 'node:stream'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  AUTO_DRAFT_MARKER, ROUTE_PREFIX, apply, attachmentPrompt,
  VISION_BRIDGE_ROUTE, directoryMemberPath, internals, normalizeMediaType, sanitizeFilename,
  restoreBridgeMainDefault, sessionContainsImages, visionBridgeCatalog,
} from '../src/index.mjs'

test('filename normalization cannot escape attachment storage', () => {
  assert.equal(sanitizeFilename('../hello?.txt'), 'hello_.txt')
  assert.equal(sanitizeFilename('..\\nested\\report.pdf'), 'report.pdf')
})

test('media type normalization cannot inject response headers', () => {
  assert.equal(normalizeMediaType('Text/Plain; charset=utf-8'), 'text/plain')
  assert.equal(normalizeMediaType('text/plain\r\nx-owned: yes'), 'application/octet-stream')
})

test('directory member paths stay below their logical attachment root', () => {
  const root = join(tmpdir(), 'dsh-attachments-root')
  assert.equal(directoryMemberPath(root, 'assets/whale.png'), join(root, 'assets', 'whale.png'))
  assert.throws(() => directoryMemberPath(root, '../outside.txt'), /invalid|escapes/)
  assert.throws(() => directoryMemberPath(root, '/outside.txt'), /invalid|escapes/)
  assert.throws(() => directoryMemberPath(root, 'C:/outside.txt'), /invalid|escapes/)
})

test('message augmentation removes the file-only marker and persists metadata', () => {
  const file = {
    id: '00000000-0000-4000-8000-000000000000',
    kind: 'file',
    name: 'notes.txt',
    mediaType: 'text/plain',
    size: 12,
    objectPath: 'C:/objects/id',
    workspacePath: '.deepseek-harness/attachments/00000000-notes.txt',
  }
  const message = {
    id: 'm1', role: 'user', source: { kind: 'user' },
    content: [{ type: 'text', text: AUTO_DRAFT_MARKER }],
  }
  const next = internals.augmentMessage(message, [file])
  assert.equal(next.content.length, 1)
  assert.match(next.content[0].text, /\.deepseek-harness\/attachments\/00000000-notes\.txt/)
  assert.deepEqual(next.source.dshAttachments, [{
    id: file.id,
    kind: 'file',
    name: file.name,
    mediaType: file.mediaType,
    size: file.size,
    path: file.workspacePath,
  }])
  const typed = internals.augmentMessage({
    ...message,
    content: [{ type: 'text', text: `${AUTO_DRAFT_MARKER}please inspect this file` }],
  }, [file])
  assert.equal(typed.content[0].text, 'please inspect this file')
  assert.equal(typed.content.some(block => block.text?.includes(AUTO_DRAFT_MARKER)), false)
  const materialized = internals.augmentMessage(next, [{ ...file, workspacePath: 'attachments/notes.txt' }])
  assert.equal(materialized.content.length, 1)
  assert.match(materialized.content[0].text, /attachments\/notes\.txt/)
  assert.doesNotMatch(materialized.content[0].text, /\.deepseek-harness/)
  assert.match(attachmentPrompt([file]), /1 个附件/)
})

function registrationContext() {
  const injections = []
  return {
    injections,
    ctx: {
      sessions: { get: () => undefined },
      webServer: { register: () => () => {} },
      inject(services, callback) {
        injections.push({ services, callback })
        return () => {}
      },
      effect(factory) {
        factory()
      },
      on() {
        return () => {}
      },
    },
  }
}

test('host registers bridge injection only when the vision bridge feature is enabled', () => {
  const omitted = registrationContext()
  apply(omitted.ctx)
  assert.deepEqual(omitted.injections, [])

  const disabled = registrationContext()
  apply(disabled.ctx, { visionBridge: false })
  assert.deepEqual(disabled.injections, [])

  const configured = registrationContext()
  apply(configured.ctx, { visionBridge: {} })
  assert.deepEqual(
    configured.injections.map(entry => entry.services),
    [['llm', 'attachments', 'tools', 'sessions']],
  )
})

test('vision guidance derives bridge choices from the current main and omits invalid vision routes', async () => {
  const adapter = {
    config: {
      provider: 'vision-bridge',
      name: 'Vision Bridge',
      visionModels: [
        {
          id: 'reader', name: 'Reader', provider: 'vision', model: 'reader',
        },
        {
          id: 'broken-reader', name: 'Broken Reader', provider: 'vision', model: 'text-reader',
        },
      ],
    },
    llm: {
      resolveModelInfo(provider, model) {
        return Promise.resolve({
          name: model === 'text' ? 'Text Main' : model === 'vision' ? 'Native Main' : model,
          inputModalities: provider === 'vision' && model === 'reader'
            ? ['text', 'image']
            : model === 'vision' ? ['text', 'image'] : ['text'],
        })
      },
    },
    visionCandidates() {
      return Promise.resolve(this.config.visionModels)
    },
  }

  const catalog = await visionBridgeCatalog(adapter, { provider: 'main', model: 'text' })
  assert.equal(catalog.provider, 'vision-bridge')
  assert.equal(catalog.providerName, 'Vision Bridge')
  assert.deepEqual(catalog.main, { provider: 'main', model: 'text', name: 'Text Main' })
  assert.equal(catalog.required, true)
  assert.equal(catalog.active, false)
  assert.equal(catalog.visionModels.length, 1)
  assert.deepEqual({ ...catalog.visionModels[0], model: '<dynamic>' }, {
    id: 'reader',
    name: 'Reader',
    model: '<dynamic>',
    bridgeName: 'Text Main · Vision via Reader',
    description: 'Uses Reader for image evidence while Text Main remains the main reasoning model.',
    group: 'Configured',
  })

  assert.deepEqual(await visionBridgeCatalog(adapter, { provider: 'main', model: 'vision' }), {
    provider: 'vision-bridge',
    providerName: 'Vision Bridge',
    main: { provider: 'main', model: 'vision', name: 'Native Main' },
    required: false,
    visionModels: [],
  })
})

test('temporary bridge selection restores the decoded underlying main as DSH default', async () => {
  const saved = []
  const main = { provider: 'main-provider', model: 'reasoner', reasoningEffort: 'high' }
  const bridge = {
    binding(model) {
      assert.equal(model, 'dynamic-bridge-route')
      return { main, vision: { provider: 'vision-provider', model: 'reader' } }
    },
  }
  const ctx = {
    get(service) {
      assert.equal(service, 'agentDefaultModel')
      return { saveSelection(selection) { saved.push(selection); return Promise.resolve() } }
    },
  }

  assert.deepEqual(
    await restoreBridgeMainDefault(ctx, bridge, 'dynamic-bridge-route'),
    main,
  )
  assert.deepEqual(saved, [main])

  assert.deepEqual(
    await restoreBridgeMainDefault(ctx, bridge, 'dynamic-bridge-route', 'max'),
    { ...main, reasoningEffort: 'max' },
  )
  assert.deepEqual(saved, [main, { ...main, reasoningEffort: 'max' }])

  await assert.rejects(
    restoreBridgeMainDefault(ctx, bridge, 'dynamic-bridge-route', ''),
    error => error.status === 400 && /reasoningEffort/.test(error.message),
  )

  await assert.rejects(
    restoreBridgeMainDefault({ get: () => undefined }, bridge, 'dynamic-bridge-route'),
    error => error.status === 503 && /default model service/.test(error.message),
  )
})

test('session image preflight follows native image blocks in durable messages', () => {
  const image = { type: 'image', attachment: { attachmentId: 'sha256:image' } }
  assert.equal(sessionContainsImages({
    deriveMessages: () => [{ content: [{ type: 'text', text: 'plain' }] }],
  }), false)
  assert.equal(sessionContainsImages({
    deriveMessages: () => [{ content: [{
      type: 'tool-result',
      content: [image],
    }] }],
  }), true)
  assert.equal(sessionContainsImages({
    events: [{ type: 'user/message', data: { content: [image] } }],
  }), true)
})

function responseCapture() {
  const capture = { status: 0, headers: {}, body: Buffer.alloc(0) }
  class CapturedResponse extends Writable {
    writeHead(status, headers = {}) {
      capture.status = status
      capture.headers = headers
      return this
    }

    _write(chunk, _encoding, callback) {
      capture.body = Buffer.concat([capture.body, Buffer.from(chunk)])
      callback()
    }
  }
  return {
    capture,
    response: new CapturedResponse(),
  }
}

test('host plugin reserves the next prompt, materializes it, and serves durable bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-attachments-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = join(root, 'home')
  const workspace = join(root, 'workspace')
  const listeners = new Map()
  const disposers = []
  const injections = []
  const routes = new Map()
  let currentMessage
  const session = { events: [], header: { cwd: workspace } }
  const emit = (name, payload) => {
    for (const listener of listeners.get(name) ?? []) listener(payload)
  }
  const agent = {
    id: 'session-1',
    session,
    inbox: {
      replace(id, message) {
        assert.equal(String(currentMessage.id), String(id))
        emit('agent/inbox/discarded', { agent, message: currentMessage })
        currentMessage = message
        emit('agent/inbox/inserted', { agent, message })
        return true
      },
    },
  }
  const ctx = {
    sessions: { get: id => id === 'session-1' ? session : undefined },
    webServer: {
      register(entry) { routes.set(entry.path, entry.handler); return () => {} },
    },
    inject(services, callback) {
      injections.push({ services, callback })
      return () => {}
    },
    effect(factory) {
      const dispose = factory()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    on(name, listener) {
      listeners.set(name, [...(listeners.get(name) ?? []), listener])
      return () => {}
    },
  }

  try {
    apply(ctx)
    assert.deepEqual(injections, [])
    const route = routes.get(ROUTE_PREFIX)
    const bridgeRoute = routes.get(VISION_BRIDGE_ROUTE)
    assert.equal(typeof route, 'function')
    assert.equal(typeof bridgeRoute, 'function')
    const bridgeRequest = Readable.from([])
    bridgeRequest.method = 'GET'
    bridgeRequest.url = `${VISION_BRIDGE_ROUTE}?sessionId=session-1`
    const bridgeResponse = responseCapture()
    await bridgeRoute(bridgeRequest, bridgeResponse.response)
    assert.deepEqual(JSON.parse(bridgeResponse.capture.body.toString()), {
      ok: true,
      provider: null,
      providerName: null,
      main: null,
      required: false,
      visionModels: [],
      sessionHasImages: false,
    })
    const upload = Readable.from([Buffer.from('hello dsh attachment')])
    upload.method = 'POST'
    upload.url = `${ROUTE_PREFIX}?sessionId=session-1&name=notes.txt&mediaType=text%2Fplain`
    // The route streams to disk and does not reject the old 64 MiB boundary.
    // This deliberately oversized declaration would have been rejected by
    // the previous implementation before reading a byte.
    upload.headers = { 'content-length': String(128 * 1024 * 1024) }
    const created = responseCapture()
    await route(upload, created.response)
    assert.equal(created.capture.status, 201)
    const file = JSON.parse(created.capture.body.toString()).file

    currentMessage = {
      id: 'message-1',
      source: { kind: 'user' },
      content: [{ type: 'text', text: AUTO_DRAFT_MARKER }],
    }
    emit('agent/inbox/inserted', { agent, message: currentMessage })
    assert.deepEqual(currentMessage.source.dshAttachments.map(row => row.id), [file.id])

    const head = Readable.from([])
    head.method = 'HEAD'
    head.url = `${ROUTE_PREFIX}/${file.id}?sessionId=session-1`
    head.headers = {}
    const reserved = responseCapture()
    await route(head, reserved.response)
    assert.equal(reserved.capture.headers['x-dsh-attachment-state'], 'reserved')

    const preStep = listeners.get('agent/pre-step')[0]
    const decision = await preStep(
      { agent, messages: [currentMessage], signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [currentMessage] }),
    )
    assert.equal(decision.kind, 'enter')
    const durable = decision.messages[0]
    assert.match(durable.source.dshAttachments[0].path, /^\.deepseek-harness\/attachments\//)
    session.events.push({ type: 'user/message', seq: 1, data: durable })
    const copied = join(workspace, ...durable.source.dshAttachments[0].path.split('/'))
    assert.equal(await readFile(copied, 'utf8'), 'hello dsh attachment')

    const download = Readable.from([])
    download.method = 'GET'
    download.url = `${ROUTE_PREFIX}/${file.id}?sessionId=session-1`
    download.headers = {}
    const served = responseCapture()
    await route(download, served.response)
    assert.equal(served.capture.status, 200)
    assert.equal(served.capture.headers['x-dsh-attachment-state'], 'committed')
    assert.equal(served.capture.body.toString(), 'hello dsh attachment')

    const createFolder = Readable.from([])
    createFolder.method = 'POST'
    createFolder.url = `${ROUTE_PREFIX}?sessionId=session-1&kind=directory&name=project&mediaType=inode%2Fdirectory`
    createFolder.headers = {}
    const folderCreated = responseCapture()
    await route(createFolder, folderCreated.response)
    assert.equal(folderCreated.capture.status, 201)
    const folder = JSON.parse(folderCreated.capture.body.toString()).file
    assert.equal(folder.kind, 'directory')

    const putEmptyDirectory = Readable.from([])
    putEmptyDirectory.method = 'PUT'
    putEmptyDirectory.url = `${ROUTE_PREFIX}/${folder.id}?sessionId=session-1&kind=directory&path=empty`
    putEmptyDirectory.headers = {}
    const emptyDirectoryCreated = responseCapture()
    await route(putEmptyDirectory, emptyDirectoryCreated.response)
    assert.equal(emptyDirectoryCreated.capture.status, 201)

    const putMember = Readable.from([Buffer.from('nested attachment')])
    putMember.method = 'PUT'
    putMember.url = `${ROUTE_PREFIX}/${folder.id}?sessionId=session-1&kind=file&path=${encodeURIComponent('src/readme.txt')}`
    putMember.headers = {}
    const memberCreated = responseCapture()
    await route(putMember, memberCreated.response)
    assert.equal(memberCreated.capture.status, 201)

    const finalizeFolder = Readable.from([])
    finalizeFolder.method = 'PATCH'
    finalizeFolder.url = `${ROUTE_PREFIX}/${folder.id}?sessionId=session-1`
    finalizeFolder.headers = {}
    const folderFinalized = responseCapture()
    await route(finalizeFolder, folderFinalized.response)
    assert.equal(folderFinalized.capture.status, 200)
    const finalizedFolder = JSON.parse(folderFinalized.capture.body.toString()).file
    assert.equal(finalizedFolder.fileCount, 1)
    assert.equal(finalizedFolder.size, Buffer.byteLength('nested attachment'))

    currentMessage = {
      id: 'message-2',
      source: { kind: 'user' },
      content: [{ type: 'text', text: AUTO_DRAFT_MARKER }],
    }
    emit('agent/inbox/inserted', { agent, message: currentMessage })
    assert.equal(currentMessage.source.dshAttachments.length, 1)
    assert.equal(currentMessage.source.dshAttachments[0].kind, 'directory')

    const folderDecision = await preStep(
      { agent, messages: [currentMessage], signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [currentMessage] }),
    )
    const durableFolder = folderDecision.messages[0]
    assert.equal(durableFolder.source.dshAttachments[0].kind, 'directory')
    assert.equal(durableFolder.source.dshAttachments[0].fileCount, 1)
    const copiedFolder = join(workspace, ...durableFolder.source.dshAttachments[0].path.split('/'))
    assert.equal(await readFile(join(copiedFolder, 'src', 'readme.txt'), 'utf8'), 'nested attachment')
    session.events.push({ type: 'user/message', seq: 2, data: durableFolder })

    const folderHead = Readable.from([])
    folderHead.method = 'HEAD'
    folderHead.url = `${ROUTE_PREFIX}/${folder.id}?sessionId=session-1`
    folderHead.headers = {}
    const folderServed = responseCapture()
    await route(folderHead, folderServed.response)
    assert.equal(folderServed.capture.status, 200)
    assert.equal(folderServed.capture.headers['content-length'], String(Buffer.byteLength('nested attachment')))
    assert.equal(folderServed.capture.headers['x-dsh-attachment-state'], 'committed')
  } finally {
    for (const dispose of disposers.reverse()) await dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(root, { recursive: true, force: true })
  }
})
