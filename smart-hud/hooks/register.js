// Tracks each MCP server's and skill's state and the prompt it was last
// touched in, so the band can show a live working/done/error state for the
// current prompt and fall back to a dim idle state for ones used earlier.
let promptIndex = 0
let currentEffort = null
const mcpState = new Map() // server name -> { promptIndex, status: 'working' | 'done' | 'error' }
const skillState = new Map() // skill name -> { promptIndex, status: 'working' | 'done' | 'error' }

const ACTIVITY_STATUS = {
  working: { icon: '🔄', color: 'success' },
  done: { icon: '✅', color: 'success' },
  error: { icon: '⚠️', color: 'error' },
  idle: { icon: '💤', color: 'inactive' },
}

function mcpServerFromTool(toolName) {
  if (!toolName || !toolName.startsWith('mcp__')) return null
  return toolName.split('__')[1] || null
}

function activityKey(toolName, input) {
  const server = mcpServerFromTool(toolName)
  if (server) return { map: mcpState, name: server }
  if (toolName === 'Skill' && input?.skill) return { map: skillState, name: input.skill }
  return null
}

function buildChips(Text, state, prompt) {
  const entries = [...state.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  return entries.flatMap(([name, s], i) => {
    const { icon, color } = s.promptIndex === prompt ? ACTIVITY_STATUS[s.status] : ACTIVITY_STATUS.idle
    const chip = Text({
      key: name,
      children: [icon + ' ' + name],
      color,
      bold: color === 'success',
      dimColor: color === 'inactive',
    })
    return i === 0 ? [chip] : [Text({ key: name + '-sep', children: [', '], color: 'inactive' }), chip]
  })
}

function formatTokens(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k'
  return String(n)
}

// Git branch is cached per cwd for a short window so a render triggered by
// every tool call / turn.step doesn't spawn a `git` process each time.
let gitCache = { cwd: null, branch: null, fetchedAt: 0 }
const GIT_CACHE_MS = 2000

async function getGitBranch($, cwd) {
  const now = Date.now()
  if (gitCache.cwd === cwd && now - gitCache.fetchedAt < GIT_CACHE_MS) {
    return gitCache.branch
  }

  let branch = null
  try {
    const result = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeoutMs: 1000 })
    if (result.exitCode === 0) branch = result.stdout.trim() || null
  } catch {
    branch = null
  }

  gitCache = { cwd, branch, fetchedAt: now }
  return branch
}

const CTX_BAR_WIDTH = 20

function progressBar(percent, width) {
  const filled = Math.round((width * Math.min(100, Math.max(0, percent))) / 100)
  return { filled: '▰'.repeat(filled), empty: '▱'.repeat(width - filled) }
}

function ctxColor(percent) {
  if (percent >= 85) return 'red'
  if (percent >= 75) return '#ff8c00'
  if (percent >= 50) return 'yellow'
  return 'success'
}

// /effort has no live getter on $.session, unlike $.session.model(). Read it
// from the same /config row the menu and /effort itself use, so a change
// shows up immediately instead of waiting for the next turn.step.
async function liveEffort($, fallback) {
  try {
    const rows = await $.config.list()
    const row = rows.find((r) => r.key === 'effort' || r.key.endsWith('.effortLevel'))
    return row?.value ?? fallback
  } catch {
    return fallback
  }
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    try {
      const settings = await $.settings.read()
      currentEffort = settings?.effortLevel ?? currentEffort
    } catch {
      // no-op: liveEffort() covers this once the first render runs
    }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    promptIndex += 1
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    // Fallback for liveEffort() when a model has no /config effort row.
    currentEffort = e.effort ?? currentEffort
    $.ui.invalidate('ui.render')
    yield* next(e)
  })

  on('tool.call', async ($, e, next) => {
    const activity = activityKey(e.tool, e.input)
    if (!activity) return next(e)

    activity.map.set(activity.name, { promptIndex, status: 'working' })
    $.ui.invalidate('ui.render')

    const result = await next(e)
    activity.map.set(activity.name, { promptIndex, status: result?.isError ? 'error' : 'done' })
    $.ui.invalidate('ui.render')
    return result
  }).catch(async ($, e) => {
    const activity = activityKey(e.tool, e.input)
    if (activity) activity.map.set(activity.name, { promptIndex, status: 'error' })
    $.ui.invalidate('ui.render')
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const { Box, Text } = $.ui.resolve(e)

    const cwd = (await $.session.cwd()) ?? ''
    const home = await $.env.get('HOME')
    const dir =
      home && cwd === home ? '~' : home && cwd.startsWith(home + '/') ? '~' + cwd.slice(home.length) : cwd || '?'
    const branch = await getGitBranch($, cwd)
    const model = (await $.session.model()) ?? '?'
    const effort = await liveEffort($, currentEffort)
    const usage = await $.session.usage()

    // Before the first turn, usage.context.percent isn't reported yet. Show
    // an empty bar at 0% instead of "?", colored gray to signal "no data
    // yet" rather than green ("0% used", which would be a false positive).
    const hasContextUsage = usage.context.percent !== undefined
    const percent = usage.context.percent ?? 0
    const cost = usage.cost?.usd
    const bar = progressBar(percent, CTX_BAR_WIDTH)
    const barColor = hasContextUsage ? ctxColor(percent) : 'inactive'

    // Each activity row (MCPs, Skills) is always present, even with nothing
    // called yet, so the band's height never changes and the rest of the
    // content doesn't jump when the first one happens.
    const activityRow = (label, state) =>
      Box({
        flexDirection: 'row',
        flexWrap: 'wrap',
        columnGap: 1,
        children: [
          Text({ children: [label], color: 'text' }),
          ...(state.size > 0
            ? buildChips(Text, state, promptIndex)
            : [Text({ children: ['None'], color: 'inactive', dimColor: true })]),
        ],
      })

    const leftColumn = Box({
      flexDirection: 'column',
      flexGrow: 1,
      flexShrink: 1,
      minWidth: 0,
      children: [activityRow('MCPs:', mcpState), activityRow('Skills:', skillState)],
    })

    const rightColumn = Box({
      flexDirection: 'column',
      alignItems: 'flex-end',
      flexShrink: 0,
      children: [
        Box({
          flexDirection: 'row',
          children: [
            Text({ children: ['🧠 ' + model], color: 'claude' }),
            Text({ children: [' · '], color: 'inactive' }),
            Text({ children: [effort ?? '?'], color: 'text' }),
            Text({ children: [' · '], color: 'inactive' }),
            Text({ children: ['💰 $' + (cost ?? 0).toFixed(2)], color: 'warning' }),
          ],
        }),
        Box({
          flexDirection: 'row',
          children: [
            Text({ children: [percent + '% '], color: barColor }),
            Text({ children: [bar.filled], color: barColor }),
            Text({ children: [bar.empty] }),
            usage.context.window
              ? Text({
                  children: [' (' + formatTokens(usage.context.tokens ?? 0) + '/' + formatTokens(usage.context.window) + ')'],
                  color: 'subtle',
                })
              : null,
          ].filter(Boolean),
        }),
      ],
    })

    return Box({
      flexDirection: 'column',
      width: e.props.bodyColumns,
      borderStyle: 'round',
      borderColor: 'promptBorder',
      paddingX: 1,
      children: [
        Box({
          flexDirection: 'row',
          justifyContent: 'center',
          children: [
            Text({ children: ['📁 ' + dir], color: 'text' }),
            branch ? Text({ children: [':' + branch], color: 'suggestion' }) : null,
          ].filter(Boolean),
        }),
        Box({
          flexDirection: 'row',
          columnGap: 3,
          children: [leftColumn, rightColumn],
        }),
      ],
    })
  })
}
