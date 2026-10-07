// Tracks which turn each MCP server was last called in, so the band can
// highlight servers used in the most recent prompt differently from ones
// used earlier in the session.
let promptIndex = 0
let currentModel = null
let currentEffort = null
const mcpLastPrompt = new Map() // server name -> promptIndex it was last called in

function mcpServerFromTool(toolName) {
  if (!toolName || !toolName.startsWith('mcp__')) return null
  return toolName.split('__')[1] || null
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    try {
      const settings = await $.settings.read()
      currentEffort = settings?.effortLevel ?? currentEffort
    } catch {
      // no-op: fall back to whatever turn.step reports later
    }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    promptIndex += 1
    $.ui.invalidate('ui.render')
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    currentModel = e.model ?? currentModel
    currentEffort = e.effort ?? currentEffort
    $.ui.invalidate('ui.render')
    yield* next(e)
  })

  on('tool.call', async ($, e, next) => {
    const server = mcpServerFromTool(e.tool)
    if (server) {
      mcpLastPrompt.set(server, promptIndex)
      $.ui.invalidate('ui.render')
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const { Box, Text } = $.ui.resolve(e)

    const cwd = (await $.session.cwd()) ?? ''
    const dir = cwd.split('/').filter(Boolean).pop() || cwd || '?'
    const model = currentModel ?? (await $.session.model()) ?? '?'

    const mcpEntries = [...mcpLastPrompt.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    const mcpChildren =
      mcpEntries.length === 0
        ? [Text({ children: ['none yet'], dimColor: true })]
        : mcpEntries.map(([name, lastIdx]) => {
            const usedInLastPrompt = lastIdx === promptIndex
            return Text({
              key: 'mcp-' + name,
              children: [name],
              color: usedInLastPrompt ? 'green' : undefined,
              bold: usedInLastPrompt,
              dimColor: !usedInLastPrompt,
            })
          })

    return Box({
      flexDirection: 'column',
      children: [
        Box({
          flexDirection: 'row',
          columnGap: 2,
          children: [
            Text({ children: ['📁 ' + dir] }),
            Text({ children: ['🧠 ' + model] }),
            Text({ children: ['⚡ ' + (currentEffort ?? '?')] }),
          ],
        }),
        Box({
          flexDirection: 'row',
          columnGap: 1,
          children: [Text({ children: ['MCP:'] }), ...mcpChildren],
        }),
      ],
    })
  })
}
