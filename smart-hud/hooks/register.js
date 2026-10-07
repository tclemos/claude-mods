// Tracks each MCP server's state and the prompt it was last touched in, so
// the band can show a live working/done/error state for the current prompt
// and fall back to a dim idle state for servers used in earlier prompts.
let promptIndex = 0
let currentModel = null
let currentEffort = null
let totalToolCalls = 0
const mcpState = new Map() // server name -> { promptIndex, status: 'working' | 'done' | 'error' }

const MCP_STATUS = {
  working: { icon: '🔄', color: 'success' },
  done: { icon: '✅', color: 'success' },
  error: { icon: '⚠️', color: 'error' },
  idle: { icon: '💤', color: 'inactive' },
}

function mcpServerFromTool(toolName) {
  if (!toolName || !toolName.startsWith('mcp__')) return null
  return toolName.split('__')[1] || null
}

const CTX_BAR_WIDTH = 30

function progressBar(percent, width) {
  const filled = Math.round((width * Math.min(100, Math.max(0, percent))) / 100)
  return { filled: '█'.repeat(filled), empty: '░'.repeat(width - filled) }
}

function ctxColor(percent) {
  if (percent >= 85) return 'red'
  if (percent >= 75) return '#ff8c00'
  if (percent >= 50) return 'yellow'
  return 'success'
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
    if (!server) return next(e)

    mcpState.set(server, { promptIndex, status: 'working' })
    $.ui.invalidate('ui.render')

    const result = await next(e)
    mcpState.set(server, { promptIndex, status: result?.isError ? 'error' : 'done' })
    $.ui.invalidate('ui.render')
    return result
  }).catch(async ($, e) => {
    const server = mcpServerFromTool(e.tool)
    if (server) mcpState.set(server, { promptIndex, status: 'error' })
    $.ui.invalidate('ui.render')
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const { Box, Text } = $.ui.resolve(e)

    const cwd = (await $.session.cwd()) ?? ''
    const home = await $.env.get('HOME')
    const dir =
      home && cwd === home ? '~' : home && cwd.startsWith(home + '/') ? '~' + cwd.slice(home.length) : cwd || '?'
    const model = currentModel ?? (await $.session.model()) ?? '?'
    const usage = await $.session.usage()

    // The MCP row is always present, even with no servers called yet, so the
    // band's height never changes and the rest of the content doesn't jump.
    // A server keeps its working/done/error state only for the prompt it
    // happened in; once a newer prompt starts, it falls back to idle.
    const mcpEntries = [...mcpState.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    const mcpChips = mcpEntries.flatMap(([name, state], i) => {
      const { icon, color } = state.promptIndex === promptIndex ? MCP_STATUS[state.status] : MCP_STATUS.idle
      const chip = Text({
        key: 'mcp-' + name,
        children: [icon + ' ' + name],
        color,
        bold: color === 'success',
        dimColor: color === 'inactive',
      })
      return i === 0 ? [chip] : [Text({ key: 'mcp-sep-' + name, children: [', '], color: 'inactive' }), chip]
    })

    const percent = usage.context.percent
    const cost = usage.cost?.usd
    const bar = percent === undefined ? null : progressBar(percent, CTX_BAR_WIDTH)
    const barColor = percent === undefined ? 'subtle' : ctxColor(percent)

    return Box({
      flexDirection: 'column',
      width: e.props.bodyColumns,
      borderStyle: 'round',
      borderColor: 'promptBorder',
      paddingX: 1,
      children: [
        Box({
          flexDirection: 'row',
          justifyContent: 'space-between',
          children: [
            Text({ children: ['📁 ' + dir], color: 'text' }),
            Text({ children: ['🧠 ' + model], color: 'claude' }),
            Text({ children: ['⚡ ' + (currentEffort ?? '?')], color: 'text' }),
          ],
        }),
        Box({
          flexDirection: 'row',
          justifyContent: 'space-between',
          children: [
            Text({ children: ['🔧 ' + totalToolCalls + ' calls'], color: 'text' }),
            Box({
              flexDirection: 'row',
              children: [
                Text({ children: ['ctx '], color: 'subtle' }),
                bar
                  ? Text({ children: [bar.filled], color: barColor })
                  : Text({ children: ['?'], color: 'subtle' }),
                bar ? Text({ children: [bar.empty], color: 'inactive', dimColor: true }) : null,
                Text({ children: [' ' + (percent ?? '?') + '%'], color: barColor }),
              ].filter(Boolean),
            }),
            Text({ children: ['💰 $' + (cost ?? 0).toFixed(2)], color: 'subtle' }),
          ],
        }),
        Box({
          flexDirection: 'row',
          flexWrap: 'wrap',
          columnGap: 1,
          children: [
            Text({ children: ['MCP'], color: 'subtle', dimColor: true }),
            ...(mcpChips.length > 0
              ? [Text({ children: ['['], color: 'inactive' }), ...mcpChips, Text({ children: [']'], color: 'inactive' })]
              : []),
          ],
        }),
      ],
    })
  })
}
