"""Regression guard for AI Chat normal-response rendering.

The plain-text renderer must not pass a forced ``diff`` language into
``isDiffCode``. That mistake classified every ordinary response as a
Suggested patch even when it contained no diff markers.
"""
from pathlib import Path

SOURCE = Path('/home/ubuntu/Examen-planner/js/tabs/ai-chat.js').read_text()

assert "var rendered = isDiffCode(source, '') ? codeArtifactHtml(source, 'diff', 0, 'Suggested patch') : mdLite(source);" in SOURCE, (
    'unfenced responses must inspect their content rather than force diff mode'
)
assert "isDiffCode(source, 'diff')" not in SOURCE, (
    'plain-text fallback must not force every normal response into a patch card'
)
assert "return String(lang || '').toLowerCase() === 'diff' || /^diff --git |^@@ /m.test(String(code || ''));" in SOURCE, (
    'actual unified-diff markers must remain supported'
)

print('AI Chat normal-response rendering contract: PASS')
