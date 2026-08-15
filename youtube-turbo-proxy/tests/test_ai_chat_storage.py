from pathlib import Path

source = Path('/home/ubuntu/Examen-planner/js/tabs/ai-chat.js').read_text()

assert 'window.PrepPathModules' in source and 'createStorageService' in source, (
    'AI Chat must use the existing IndexedDB-backed storage service when available'
)
assert 'service.readCache(storageUid, { threads: baseline })' in source, (
    'AI Chat must hydrate threads from durable local storage'
)
assert 'service.writeCache(storageUid, snapshot)' in source, (
    'AI Chat must persist full thread state durably after changes'
)
assert 'var _threadMemory = null' in source and 'function saveThreads(list)' in source, (
    'AI Chat must keep a current in-memory thread snapshot during an active request'
)
assert 'localStorage mirror full; using IndexedDB for thread state' in source, (
    'localStorage quota failures must not discard the current thread state'
)
assert "function storageUidFor(userId) { return 'ai-chat:'" in source, (
    'AI Chat durable records must be namespaced away from the main app cache'
)
assert 'hydrateThreadStorage();' in source and 'preppath:modules-ready' in source, (
    'Durable hydration must run after Firebase/module readiness'
)
assert 'resetThreadCacheForUser(user && user.uid);' in source, (
    'Changing auth users must reset the in-memory thread cache'
)
print('AI Chat durable image-thread storage contract: PASS')
