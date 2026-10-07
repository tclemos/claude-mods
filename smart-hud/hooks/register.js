// Tracks which turn each MCP server was last called in, so the band can
// highlight servers used in the most recent prompt differently from ones
// used earlier in the session.
let promptIndex = 0
let currentModel = null
let currentEffort = null
let totalToolCalls = 0
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
    totalToolCalls += 1
    const server = mcpServerFromTool(e.tool)
    if (server) {
      mcpLastPrompt.set(server, promptIndex)
    }
    $.ui.invalidate('ui.render')
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const { Box, Text } = $.ui.resolve(e)

    const cwd = (await $.session.cwd()) ?? ''
    const home = await $.env.get('HOME')
    const dir =
      home && cwd === home ? '~' : home && cwd.startsWith(home + '/') ? '~' + cwd.slice(home.length) : cwd || '?'
    const model = currentModel ?? (await $.session.model()) ?? '?'
    const usage = await $.session.usage()

    const sep = (key) => Text({ key, children: [' │ '], color: 'inactive' })

    // The MCP row is always present, even with no servers called yet, so the
    // band's height never changes and the rest of the content doesn't jump.
    const mcpEntries = [...mcpLastPrompt.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    const mcpChips = mcpEntries.flatMap(([name, lastIdx], i) => {
      const usedInLastPrompt = lastIdx === promptIndex
      const chip = Text({
        key: 'mcp-' + name,
        children: [name],
        color: usedInLastPrompt ? 'success' : 'inactive',
        bold: usedInLastPrompt,
        dimColor: !usedInLastPrompt,
      })
      return i === 0 ? [chip] : [sep('mcp-sep-' + name), chip]
    })

    const percent = usage.context.percent
    const percentColor = percent >= 90 ? 'error' : percent >= 70 ? 'warning' : 'subtle'
    const cost = usage.cost?.usd

    return Box({
      flexDirection: 'column',
      borderStyle: 'round',
      borderColor: 'promptBorder',
      paddingX: 1,
      children: [
        Box({
          flexDirection: 'row',
          children: [
            Text({ children: ['📁 ' + dir], color: 'text' }),
            sep('sep-1'),
            Text({ children: ['🧠 ' + model], color: 'claude' }),
            sep('sep-2'),
            Text({ children: ['⚡ ' + (currentEffort ?? '?')], color: 'subtle' }),
          ],
        }),
        Box({
          flexDirection: 'row',
          children: [
            Text({ children: ['🧩 ' + totalToolCalls + ' calls'], color: 'text' }),
            sep('sep-3'),
            Text({ children: ['📊 ' + (percent ?? '?') + '% ctx'], color: percentColor }),
            sep('sep-4'),
            Text({ children: ['💰 $' + (cost ?? 0).toFixed(2)], color: 'subtle' }),
          ],
        }),
        Box({
          flexDirection: 'row',
          columnGap: 1,
          children: [Text({ children: ['MCP'], color: 'subtle', dimColor: true }), ...mcpChips],
        }),
      ],
    })
  })
}
