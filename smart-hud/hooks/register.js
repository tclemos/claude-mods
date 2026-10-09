// Tracks each MCP server's and skill's state and the prompt it was last
// touched in, so the band can show a live working/done/error state for the
// current prompt and fall back to a dim idle state for ones used earlier.
let promptIndex = 0
let currentEffort = null
let knownModelId = null
let knownModelLabel = null
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

// A tool call carries its arguments on the event itself ({ tool, tool_use_id }
// & the tool's own input), so the Skill tool's name is e.skill — not e.input.
function activityKey(e) {
  const server = mcpServerFromTool(e.tool)
  if (server) return { map: mcpState, name: server }
  if (e.tool === 'Skill' && e.skill) return { map: skillState, name: e.skill }
  return null
}

// The status icon is the chip's control, so the name beside it can keep the
// colour that carries the status — a Button has none of its own.
function buildChips(Box, Text, pressable, state, prompt, command) {
  const entries = [...state.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  return entries.flatMap(([name, s], i) => {
    const { icon, color } = s.promptIndex === prompt ? ACTIVITY_STATUS[s.status] : ACTIVITY_STATUS.idle
    const chip = Box({
      key: 'chip-' + name,
      flexDirection: 'row',
      children: [
        pressable('chip-' + command + '-' + name, icon, command, name),
        Text({
          children: [' ' + name],
          color,
          bold: color === 'success',
          dimColor: color === 'inactive',
        }),
      ],
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

// Effort has no live getter on $.session and no /config row either: it is kept
// per model, as settings.modelSettings[<model id>].effortLevel. Only turn.step
// reveals which id this session resolved to, so before the first turn — and
// after a model switch the next turn hasn't confirmed yet — the value is
// genuinely unknown and the band shows nothing instead of the previous model's.
async function liveEffort($, modelLabel) {
  if (!knownModelId || modelLabel !== knownModelLabel) return null
  try {
    const settings = await $.settings.read()
    return settings?.modelSettings?.[knownModelId]?.effortLevel ?? currentEffort
  } catch {
    return currentEffort
  }
}

// /model and /effort may return before their picker has settled, and the engine
// raises no event for the write, so poll for the value to actually change and
// redraw once it does. Bounded, so a dismissed picker stops costing anything.
const PICK_POLL_MS = 500
const PICK_POLL_TICKS = 40

async function modelEffortSignature($) {
  const label = await $.session.model()
  return label + '/' + (await liveEffort($, label))
}

async function refreshAfterPick($, e, next) {
  const before = await modelEffortSignature($)
  const result = await next(e)

  let ticks = 0
  const timer = $.clock.every(PICK_POLL_MS, async () => {
    ticks += 1
    if ((await modelEffortSignature($)) !== before) {
      $.ui.invalidate('ui.render')
      timer.cancel()
    } else if (ticks >= PICK_POLL_TICKS) {
      timer.cancel()
    }
  })

  return result
}

export function register(on) {
  on('command.run', { command: 'model' }, refreshAfterPick)
  on('command.run', { command: 'effort' }, refreshAfterPick)

  on('prompt.submit', async ($, e, next) => {
    promptIndex += 1
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    currentEffort = e.effort ?? currentEffort
    knownModelId = e.model ?? knownModelId
    knownModelLabel = await $.session.model()
    $.ui.invalidate('ui.render')
    yield* next(e)
  })

  on('tool.call', async ($, e, next) => {
    const activity = activityKey(e)
    if (!activity) return next(e)

    activity.map.set(activity.name, { promptIndex, status: 'working' })
    $.ui.invalidate('ui.render')

    const result = await next(e)
    activity.map.set(activity.name, { promptIndex, status: result?.isError ? 'error' : 'done' })
    $.ui.invalidate('ui.render')
    return result
  }).catch(async ($, e) => {
    const activity = activityKey(e)
    if (activity) activity.map.set(activity.name, { promptIndex, status: 'error' })
    $.ui.invalidate('ui.render')
  })

  // The tool call above only sees a skill the model invoked; this catches the
  // ones a typed /name expands, which never reach the Skill tool.
  on('skill.prompt', async ($, e, next) => {
    skillState.set(e.skill, { promptIndex, status: 'working' })
    $.ui.invalidate('ui.render')

    const result = await next(e)
    skillState.set(e.skill, { promptIndex, status: 'done' })
    $.ui.invalidate('ui.render')
    return result
  }).catch(async ($, e) => {
    skillState.set(e.skill, { promptIndex, status: 'error' })
    $.ui.invalidate('ui.render')
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const { Box, Text, Button } = $.ui.resolve(e)

    // Button is the only element that takes a press and it carries no colour of
    // its own; Text is the only one that does. So a readout keeps its colour by
    // splitting: the icon is the control, the value stays Text beside it.
    const pressable = (key, label, command, args) =>
      Button({
        key,
        label,
        plain: true,
        // `hover` binds to the nearest enclosing keyed Box, so the control
        // underlines whenever the pointer is anywhere over its row. `inverse:
        // false` cancels the background the pointer otherwise paints, which the
        // docs call unconditional but the surface does honour.
        hover: { underline: true, inverse: false },
        onPress: () => {
          $.command.run({ command, args }).catch(() => $.ui.toast('/' + command + ' could not run'))
        },
      })

    // The keyed Box is what `hover` above reacts to; without a key it is refused.
    const readout = (key, icon, value, command, color) =>
      Box({
        key: 'readout-' + key,
        flexDirection: 'row',
        children: [pressable(key, icon, command), Text({ children: [' ' + value], color })],
      })

    const cwd = (await $.session.cwd()) ?? ''
    const home = await $.env.get('HOME')
    const dir =
      home && cwd === home ? '~' : home && cwd.startsWith(home + '/') ? '~' + cwd.slice(home.length) : cwd || '?'
    const branch = await getGitBranch($, cwd)
    const modelLabel = await $.session.model()
    const model = modelLabel ?? '?'
    const effort = await liveEffort($, modelLabel)
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
    const activityRow = (label, state, commandKey) =>
      Box({
        key: 'readout-' + commandKey,
        flexDirection: 'row',
        flexWrap: 'wrap',
        columnGap: 1,
        children: [
          pressable(commandKey, label, commandKey),
          ...(state.size > 0
            ? buildChips(Box, Text, pressable, state, promptIndex, commandKey)
            : [Text({ children: ['None'], color: 'inactive', dimColor: true })]),
        ],
      })

    const leftColumn = Box({
      flexDirection: 'column',
      flexGrow: 1,
      flexShrink: 1,
      minWidth: 0,
      children: [activityRow('MCPs:', mcpState, 'mcp'), activityRow('Skills:', skillState, 'skills')],
    })

    const rightColumn = Box({
      flexDirection: 'column',
      alignItems: 'flex-end',
      flexShrink: 0,
      children: [
        Box({
          flexDirection: 'row',
          children: [
            readout('model', '🧠', model, 'model', 'claude'),
            effort ? Text({ children: [' · '], color: 'inactive' }) : null,
            effort ? readout('effort', '💪', effort, 'effort', 'text') : null,
            Text({ children: [' · '], color: 'inactive' }),
            readout('cost', '💰', '$' + (cost ?? 0).toFixed(2), 'usage', 'warning'),
          ].filter(Boolean),
        }),
        Box({
          key: 'readout-context',
          flexDirection: 'row',
          children: [
            pressable('context', '📊', 'context'),
            Text({ children: [' ' + percent + '% '], color: barColor }),
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
