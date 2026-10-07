declare module 'claude-code' {
  interface PluginState {
    'smart-hud': {
      totalInputTokens: number
      totalOutputTokens: number
      promptInputTokens: number
      promptOutputTokens: number
    }
  }
}
