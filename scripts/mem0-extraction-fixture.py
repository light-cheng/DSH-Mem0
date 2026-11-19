"""Build test/fixtures/mem0-2.2.1-extraction.json from the mem0ai 2.2.1 wheel.

Only pure helper functions are taken (by ast) from the wheel's source and
run with the standard library; mem0 itself is never imported.
Usage: python3 -I make_fixture.py <wheel-dir> <out.json>
"""
import ast, json, re, sys, hashlib
from datetime import datetime, timezone
from typing import Any

src_dir, out_path = sys.argv[1], sys.argv[2]
wanted = {
    'mem0/configs/prompts.py': ['_truncate_content', '_format_summary', '_format_conversation_history', '_serialize_memories', '_format_new_messages', '_resolve_dates', 'generate_additive_extraction_prompt'],
    'mem0/memory/utils.py': ['parse_messages', 'remove_code_blocks', 'extract_json'],
    'mem0/memory/main.py': ['_escape_scope_value', '_build_session_scope'],
}
consts = {'mem0/configs/prompts.py': ['PAST_MESSAGE_TRUNCATION_LIMIT', 'ADDITIVE_EXTRACTION_PROMPT', 'AGENT_CONTEXT_SUFFIX']}
ns = {'json': json, 're': re, 'datetime': datetime, 'timezone': timezone, 'Any': Any}
for rel, names in wanted.items():
    tree = ast.parse(open(f'{src_dir}/{rel}', encoding='utf-8').read())
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(getattr(t, 'id', None) in consts.get(rel, []) for t in node.targets):
            ns[node.targets[0].id] = ast.literal_eval(node.value)
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name in names:
            exec(compile(ast.Module(body=[node], type_ignores=[]), rel, 'exec'), ns)
PAST_LIMIT = ns['PAST_MESSAGE_TRUNCATION_LIMIT']

long_zh = '我在做一个叫 Falcon 的项目，' * 30
cases = []
def add_case(name, messages, last, existing, filters, date='2026-11-20'):
    parsed = ns['parse_messages'](messages)
    user = ns['generate_additive_extraction_prompt'](existing_memories=existing, new_messages=parsed, last_k_messages=last, current_date=date, use_input_language=True)
    agent_scoped = bool(filters.get('agent_id')) and not filters.get('user_id')
    system = ns['ADDITIVE_EXTRACTION_PROMPT'] + (ns['AGENT_CONTEXT_SUFFIX'] if agent_scoped else '')
    cases.append({
        'name': name, 'messages': messages, 'lastMessages': last, 'existingMemories': existing, 'filters': filters, 'date': date,
        'parsed': parsed, 'sessionScope': ns['_build_session_scope'](filters), 'agentScoped': agent_scoped,
        'systemSha256': hashlib.sha256(system.encode()).hexdigest(), 'user': user,
    })

add_case('english, no history', [{'role': 'user', 'content': 'I always drink green tea in the morning.'}, {'role': 'assistant', 'content': 'Noted!'}], [], [], {'user_id': 'u1', 'agent_id': 'dsh'})
add_case('chinese with history and existing memories', [
    {'role': 'system', 'content': 'context'},
    {'role': 'user', 'content': '我喜欢用 "中文 + English" 写发布说明\n每次都这样。'},
    {'role': 'assistant', 'content': None},
    {'role': 'tool', 'content': 'ignored'},
    {'role': 'assistant', 'content': '好的，记住了 ✅'},
], [
    {'role': 'user', 'content': long_zh, 'name': None, 'created_at': 'x'},
    {'role': 'assistant', 'content': '', 'name': None, 'created_at': 'x'},
    {'role': 'assistant', 'content': 'emoji 🚀' * 200, 'name': 'bot', 'created_at': 'x'},
], [{'id': '0', 'text': 'Writes release notes in "both" languages'}, {'id': '1', 'text': '用户住在\t上海\n浦东'}, {'id': '2', 'text': 'ctrl \x01   char'}], {'user_id': 'a&b=c%d'})
add_case('agent scoped', [{'role': 'user', 'content': 'Use pnpm for this repo.'}], [], [], {'agent_id': 'dsh', 'run_id': 'r1'})

parse_cases = []
for answer in ['{"memory": [{"text": "Likes tea"}]}', '```json\n{"memory": [{"text": "A"}]}\n```', '<think>hmm</think>{"memory": []}',
               'Sure! Here it is: {"memory": [{"text": "B"}]} hope it helps', '{"memory": [{"text": "line\nbreak"}]}', '', '   ', 'not json at all']:
    cleaned = ns['remove_code_blocks'](answer)
    if not cleaned or not cleaned.strip():
        memories = []
    else:
        try:
            memories = json.loads(cleaned, strict=False).get('memory', [])
        except json.JSONDecodeError:
            try:
                memories = json.loads(ns['extract_json'](cleaned), strict=False).get('memory', [])
            except Exception:
                memories = None
    parse_cases.append({'answer': answer, 'cleaned': cleaned, 'extracted': ns['extract_json'](cleaned), 'memories': memories})

out = {
    'source': 'mem0ai 2.2.1 wheel (pure helpers only, run with the standard library)',
    'pastMessageTruncationLimit': PAST_LIMIT,
    'cases': cases,
    'parse': parse_cases,
}
with open(out_path, 'w', encoding='utf-8') as fh:
    json.dump(out, fh, ensure_ascii=False, indent=1)
    fh.write('\n')
print(len(cases), len(parse_cases))
