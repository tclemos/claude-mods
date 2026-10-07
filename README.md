# claude-mods

Mods pessoais para o [Claude Code](https://code.claude.com/docs/en/plugins/mods/overview). Cada subdiretório é um mod independente (plugin).

## Carregar os mods

Aponte `CLAUDE_CODE_PLUGIN_DIRS` em `~/.claude/settings.json` para o(s) diretório(s) dos mods, separados por `:`. Exemplo para carregar todos os mods deste repo:

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "/caminho/para/claude-mods/smart-hud"
  }
}
```

Após clonar em outra máquina, ajuste o caminho para o local correto.

## Mods

### smart-hud

Faixa acima do prompt com diretório atual, modelo, effort level e atividade de MCPs na sessão (destaque para os usados no último prompt).
