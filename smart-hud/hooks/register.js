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

    const sep = () => Text({ children: [' │ '], color: 'inactive' })

    const children = [
      Box({
        flexDirection: 'row',
        children: [
          Text({ children: ['📁 ' + dir], color: 'text' }),
          sep(),
          Text({ children: ['🧠 ' + model], color: 'claude' }),
          sep(),
          Text({ children: ['⚡ ' + (currentEffort ?? '?')], color: 'subtle' }),
        ],
      }),
    ]

    // Only show the MCP row once an MCP server has actually been called.
    const mcpEntries = [...mcpLastPrompt.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    if (mcpEntries.length > 0) {
      children.push(
        Box({
          flexDirection: 'row',
          columnGap: 1,
          children: [
            Text({ children: ['MCP'], color: 'subtle', dimColor: true }),
            ...mcpEntries.map(([name, lastIdx]) => {
              const usedInLastPrompt = lastIdx === promptIndex
              return Text({
                key: 'mcp-' + name,
                children: [name],
                color: usedInLastPrompt ? 'success' : 'inactive',
                bold: usedInLastPrompt,
                dimColor: !usedInLastPrompt,
              })
            }),
          ],
        }),
      )
    }

    return Box({
      flexDirection: 'column',
      borderStyle: 'round',
      borderColor: 'promptBorder',
      paddingX: 1,
      children,
    })
  })
}
