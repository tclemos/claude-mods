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

Faixa acima do prompt com:

- Diretório atual (`~/...`)
- MCPs e skills usados na sessão, com estado ao vivo: 🔄 chamando, ✅ concluído, ⚠️ erro (neste prompt), 💤 ocioso (usado em prompt anterior)
- Modelo, effort level (atualizado em tempo real, sem esperar o próximo prompt) e custo acumulado da sessão
- Barra de uso do context window, com gradiente de cor (verde → amarelo → laranja → vermelho) e tokens usados/limite
