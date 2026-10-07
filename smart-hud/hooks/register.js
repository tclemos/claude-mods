// Tracks each MCP server's state and the prompt it was last touched in, so
// the band can show a live working/done/error state for the current prompt
// and fall back to a dim idle state for servers used in earlier prompts.
let promptIndex = 0
let currentModel = null
let currentEffort = null
let totalInputTokens = 0
let totalOutputTokens = 0
const mcpState = new Map() // server name -> { promptIndex, status: 'working' | 'done' | 'error' }

function formatTokens(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k'
  return String(n)
}

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
    const result = yield* next(e)
    if (result?.usage) {
      const u = result.usage
      totalInputTokens += u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
      totalOutputTokens += u.output_tokens
      $.ui.invalidate('ui.render')
    }
    return result
  })

  on('tool.call', async ($, e, next) => {
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

    const leftColumn = Box({
      flexDirection: 'column',
      flexGrow: 1,
      children: [
        Text({ children: ['📁 ' + dir], color: 'text' }),
        Box({
          flexDirection: 'row',
          flexWrap: 'wrap',
          columnGap: 1,
          children: [
            Text({ children: ['MCPs in use:'], color: 'text' }),
            ...(mcpChips.length > 0 ? mcpChips : [Text({ children: ['None'], color: 'inactive', dimColor: true })]),
          ],
        }),
      ],
    })

    const rightColumn = Box({
      flexDirection: 'column',
      alignItems: 'flex-end',
      children: [
        Box({
          flexDirection: 'row',
          children: [
            Text({ children: ['💰 $' + (cost ?? 0).toFixed(2)], color: 'subtle' }),
            Text({ children: [' · '], color: 'inactive' }),
            Text({ children: ['↑' + formatTokens(totalInputTokens)], color: 'text' }),
            Text({ children: [' '], color: 'text' }),
            Text({ children: ['↓' + formatTokens(totalOutputTokens)], color: 'text' }),
            Text({ children: [' '], color: 'text' }),
            Text({ children: ['Σ' + formatTokens(totalInputTokens + totalOutputTokens)], color: 'text' }),
          ],
        }),
        Box({
          flexDirection: 'row',
          children: [
            Text({ children: ['🧠 ' + model], color: 'claude' }),
            Text({ children: [' · '], color: 'inactive' }),
            Text({ children: [currentEffort ?? '?'], color: 'text' }),
          ],
        }),
        Box({
          flexDirection: 'row',
          children: [
            Text({ children: ['ctx '], color: 'text' }),
            bar ? Text({ children: [bar.filled], color: barColor }) : Text({ children: ['?'], color: 'subtle' }),
            bar ? Text({ children: [bar.empty], color: 'inactive', dimColor: true }) : null,
            Text({ children: [' ' + (percent ?? '?') + '%'], color: barColor }),
          ].filter(Boolean),
        }),
      ],
    })

    return Box({
      flexDirection: 'row',
      width: e.props.bodyColumns,
      borderStyle: 'round',
      borderColor: 'promptBorder',
      paddingX: 1,
      children: [leftColumn, rightColumn],
    })
  })
}
