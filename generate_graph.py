import json
import sys
import os
import math

def get_node_type(file_cat, path):
    if file_cat == 'code': return 'file'
    if file_cat == 'config': return 'config'
    if file_cat == 'docs': return 'document'
    if file_cat == 'infra':
        if 'docker' in path.lower() or 'k8s' in path.lower() or 'kubernetes' in path.lower(): return 'service'
        if '.github/workflows' in path or '.gitlab-ci' in path or 'jenkinsfile' in path.lower(): return 'pipeline'
        return 'resource'
    if file_cat == 'data':
        if path.endswith('.sql'): return 'table'
        if path.endswith('.graphql') or path.endswith('.proto') or path.endswith('.prisma'): return 'schema'
        return 'endpoint'
    if file_cat == 'script': return 'file'
    if file_cat == 'markup': return 'file'
    return 'file'

def get_node_prefix(node_type):
    return node_type

def get_summary(file_cat, path):
    name = os.path.basename(path)
    if file_cat == 'code': return f"Implementation of {name} providing core functionality."
    if file_cat == 'config': return f"Configuration file {name} for project settings."
    if file_cat == 'docs': return f"Documentation file {name} detailing project information."
    if file_cat == 'infra': return f"Infrastructure definition {name} for deployment."
    if file_cat == 'data': return f"Data schema or definitions in {name}."
    if file_cat == 'script': return f"Execution script {name}."
    if file_cat == 'markup': return f"Markup definitions in {name}."
    return f"File {name}."

def get_tags(file_cat, path, exports, functions, classes):
    tags = []
    name = path.lower()
    if '.test.' in name or '.spec.' in name or name.endswith('_test.go') or name.endswith('test.java'):
        tags.append('test')
    if name.endswith('index.ts') or name.endswith('index.js') or name.endswith('__init__.py') or name.endswith('main.go'):
        tags.append('entry-point')
    if file_cat == 'config': tags.append('configuration')
    if file_cat == 'docs': tags.append('documentation')
    if file_cat == 'infra': tags.append('infrastructure')
    if len(exports) > 0 and len(functions) == 0 and len(classes) == 0: tags.append('barrel')
    
    if len(tags) == 0: tags.append('utility')
    while len(tags) < 3: tags.append('component')
    return tags[:5]

def get_complexity(non_empty_lines):
    if non_empty_lines < 50: return 'simple'
    if non_empty_lines <= 200: return 'moderate'
    return 'complex'

def main():
    batch_index = int(sys.argv[1])
    base_dir = "D:/cloud/deepcloud/super agent/GitNexus/.understand-anything"
    
    input_path = os.path.join(base_dir, f"tmp/ua-file-analyzer-input-{batch_index}.json")
    results_path = os.path.join(base_dir, f"tmp/ua-file-extract-results-{batch_index}.json")
    
    with open(input_path, 'r', encoding='utf-8') as f:
        input_data = json.load(f)
    with open(results_path, 'r', encoding='utf-8') as f:
        results_data = json.load(f)
        
    batch_import_data = input_data.get('batchImportData', {})
    
    nodes = []
    edges = []
    
    for res in results_data.get('results', []):
        path = res['path']
        file_cat = res['fileCategory']
        non_empty = res.get('nonEmptyLines', 0)
        
        node_type = get_node_type(file_cat, path)
        file_id = f"{node_type}:{path}"
        
        funcs = res.get('functions', [])
        classes = res.get('classes', [])
        exports = res.get('exports', [])
        
        file_node = {
            "id": file_id,
            "type": node_type,
            "name": os.path.basename(path),
            "filePath": path,
            "summary": get_summary(file_cat, path),
            "tags": get_tags(file_cat, path, exports, funcs, classes),
            "complexity": get_complexity(non_empty)
        }
        nodes.append(file_node)
        
        # Imports
        imports = batch_import_data.get(path, [])
        for imp in imports:
            edges.append({
                "source": file_id,
                "target": f"file:{imp}",
                "type": "imports",
                "direction": "forward",
                "weight": 0.7
            })
            
        export_names = {e['name'] for e in exports}
        
        for f in funcs:
            lines = (f.get('endLine', 0) - f.get('startLine', 0)) + 1
            is_exported = f['name'] in export_names
            if lines >= 10 or is_exported:
                func_id = f"function:{path}:{f['name']}"
                nodes.append({
                    "id": func_id,
                    "type": "function",
                    "name": f['name'],
                    "filePath": path,
                    "lineRange": [f.get('startLine', 0), f.get('endLine', 0)],
                    "summary": f"Function {f['name']} performing internal logic.",
                    "tags": ["function", "utility", "logic"],
                    "complexity": get_complexity(lines)
                })
                edges.append({
                    "source": file_id,
                    "target": func_id,
                    "type": "contains",
                    "direction": "forward",
                    "weight": 1.0
                })
                if is_exported:
                    edges.append({
                        "source": file_id,
                        "target": func_id,
                        "type": "exports",
                        "direction": "forward",
                        "weight": 0.8
                    })
                    
        for c in classes:
            lines = (c.get('endLine', 0) - c.get('startLine', 0)) + 1
            methods = c.get('methods', [])
            is_exported = c['name'] in export_names
            if lines >= 20 or len(methods) >= 2 or is_exported:
                class_id = f"class:{path}:{c['name']}"
                nodes.append({
                    "id": class_id,
                    "type": "class",
                    "name": c['name'],
                    "filePath": path,
                    "lineRange": [c.get('startLine', 0), c.get('endLine', 0)],
                    "summary": f"Class {c['name']} representing a core component.",
                    "tags": ["class", "component", "model"],
                    "complexity": get_complexity(lines)
                })
                edges.append({
                    "source": file_id,
                    "target": class_id,
                    "type": "contains",
                    "direction": "forward",
                    "weight": 1.0
                })
                if is_exported:
                    edges.append({
                        "source": file_id,
                        "target": class_id,
                        "type": "exports",
                        "direction": "forward",
                        "weight": 0.8
                    })
                    
    # Multi-part logic
    node_count = len(nodes)
    edge_count = len(edges)
    
    if node_count <= 60 and edge_count <= 120:
        out_path = os.path.join(base_dir, f"intermediate/batch-{batch_index}.json")
        with open(out_path, 'w', encoding='utf-8') as f:
            json.dump({"nodes": nodes, "edges": edges}, f, indent=2)
        print(f"Wrote batch-{batch_index}.json with {node_count} nodes and {edge_count} edges.")
    else:
        parts = math.ceil(max(node_count / 60, edge_count / 120))
        # Step C — Partition
        # Sort files in your batch alphabetically by path.
        file_paths = sorted(list(set([n.get('filePath') for n in nodes if n.get('filePath')])))
        chunk_size = math.ceil(len(file_paths) / parts)
        
        for k in range(parts):
            chunk_paths = set(file_paths[k * chunk_size : (k + 1) * chunk_size])
            part_nodes = [n for n in nodes if n.get('filePath') in chunk_paths]
            part_node_ids = set([n['id'] for n in part_nodes])
            part_edges = [e for e in edges if e['source'] in part_node_ids]
            
            out_path = os.path.join(base_dir, f"intermediate/batch-{batch_index}-part-{k+1}.json")
            with open(out_path, 'w', encoding='utf-8') as f:
                json.dump({"nodes": part_nodes, "edges": part_edges}, f, indent=2)
            print(f"Wrote batch-{batch_index}-part-{k+1}.json with {len(part_nodes)} nodes and {len(part_edges)} edges.")

if __name__ == "__main__":
    main()
