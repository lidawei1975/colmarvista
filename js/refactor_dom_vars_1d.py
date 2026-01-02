import re

file_path = r"d:\orapps\aws\colmarview\js\1d.js"

with open(file_path, 'r', encoding='utf-8') as f:
    content = f.read()

replacements = [
    (r'\btooldiv\b', '$tooldiv'),
    (r'\boOutput\b', '$oOutput'),
]

for pattern, repl in replacements:
    content = re.sub(pattern, repl, content)

with open(file_path, 'w', encoding='utf-8') as f:
    f.write(content)

print(f"Refactoring complete for {file_path}")
