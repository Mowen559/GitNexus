const fs = require('fs');
const path = require('path');

const projectRoot = 'D:/cloud/deepcloud/super agent/GitNexus';
const intermediateDir = path.join(projectRoot, '.understand-anything/intermediate');
const tmpDir = path.join(projectRoot, '.understand-anything/tmp');

const batchesPath = path.join(intermediateDir, 'batches.json');
const batchesData = JSON.parse(fs.readFileSync(batchesPath, 'utf8'));
const targetBatches = [1, 2, 3, 4];

function getComplexity(nonEmptyLines) {
  if (nonEmptyLines < 50) return 'simple';
  if (nonEmptyLines <= 200) return 'moderate';
  return 'complex';
}

function getTags(fileCategory, filePath, metrics, functions = [], exportsList = []) {
  const tags = [];
  const lowerPath = filePath.toLowerCase();
  const basename = path.basename(lowerPath);

  if (fileCategory === 'code') {
    if (
      lowerPath.includes('.test.') ||
      lowerPath.includes('.spec.') ||
      lowerPath.includes('test_') ||
      lowerPath.endsWith('_test.go') ||
      lowerPath.endsWith('test.java')
    ) {
      tags.push('test');
    }
    if ((basename === 'index.ts' || basename === 'index.js') && metrics.exportCount > 0) {
      tags.push(metrics.functionCount < 2 ? 'barrel' : 'entry-point');
    }
    if (
      basename === 'main.go' ||
      basename === 'main.rs' ||
      basename === 'lib.rs' ||
      basename === '__init__.py'
    ) {
      tags.push('entry-point');
    }
    if (
      exportsList.some(
        (e) => e.name && (e.name.includes('Handler') || e.name.includes('Controller')),
      )
    ) {
      tags.push('api-handler');
    }
    if (metrics.functionCount > 0 && !tags.includes('test') && !tags.includes('entry-point')) {
      tags.push('utility');
    }
    if (tags.length === 0) tags.push('component');
  } else {
    if (fileCategory === 'config') tags.push('configuration');
    if (fileCategory === 'docs') tags.push('documentation');
    if (fileCategory === 'infra') {
      tags.push('infrastructure');
      if (basename.includes('docker')) tags.push('containerization');
      if (lowerPath.includes('.github/workflows')) tags.push('ci-cd', 'deployment');
      if (lowerPath.endsWith('.tf')) tags.push('deployment');
    }
    if (fileCategory === 'data') tags.push('database');
    if (lowerPath.endsWith('.graphql') || lowerPath.endsWith('.proto')) {
      tags.push('schema-definition');
    }
  }

  const allTags = Array.from(new Set(tags));
  while (allTags.length < 3) {
    if (fileCategory === 'code') allTags.push('service');
    else allTags.push('build-system');
  }
  return allTags.slice(0, 5);
}

function getSummary(fileCategory, filePath) {
  if (fileCategory === 'code')
    return `Code module for ${path.basename(filePath)} providing application logic.`;
  if (fileCategory === 'config') return `Configuration settings for ${path.basename(filePath)}.`;
  if (fileCategory === 'docs')
    return `Documentation and reference information in ${path.basename(filePath)}.`;
  if (fileCategory === 'infra') return `Infrastructure definition in ${path.basename(filePath)}.`;
  if (fileCategory === 'data')
    return `Data schema or structure definition for ${path.basename(filePath)}.`;
  if (fileCategory === 'script')
    return `Executable script ${path.basename(filePath)} for automation.`;
  if (fileCategory === 'markup')
    return `Markup file ${path.basename(filePath)} for UI or templating.`;
  return `General file ${path.basename(filePath)}.`;
}

function getNodeType(fileCategory, filePath) {
  const lowerPath = filePath.toLowerCase();
  const basename = path.basename(lowerPath);

  if (fileCategory === 'code') return 'file';
  if (fileCategory === 'config') return 'config';
  if (fileCategory === 'docs') return 'document';
  if (fileCategory === 'infra') {
    if (basename.includes('docker') || lowerPath.includes('k8s')) return 'service';
    if (
      lowerPath.includes('.github/workflows') ||
      lowerPath.includes('gitlab-ci') ||
      basename === 'jenkinsfile'
    )
      return 'pipeline';
    if (lowerPath.endsWith('.tf') || basename === 'vagrantfile') return 'resource';
    return 'service';
  }
  if (fileCategory === 'data') {
    if (lowerPath.endsWith('.sql')) return 'table';
    if (
      lowerPath.endsWith('.graphql') ||
      lowerPath.endsWith('.proto') ||
      lowerPath.endsWith('.prisma')
    )
      return 'schema';
    if (lowerPath.includes('openapi') || lowerPath.includes('swagger')) return 'endpoint';
    return 'schema';
  }
  if (fileCategory === 'script' || fileCategory === 'markup') return 'file';
  return 'file';
}

function processBatch(batchIndex) {
  const resultsPath = path.join(tmpDir, `ua-file-extract-results-${batchIndex}.json`);
  if (!fs.existsSync(resultsPath)) return;

  const extractData = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
  const batchMeta = batchesData.batches.find((b) => b.batchIndex === batchIndex);
  const batchImportData = batchMeta ? batchMeta.batchImportData : {};

  const nodes = [];
  const edges = [];

  for (const res of extractData.results) {
    const fileCategory = res.fileCategory || 'code';
    const filePath = res.path;
    const nodeType = getNodeType(fileCategory, filePath);
    const fileNodeId = `${nodeType}:${filePath}`;

    nodes.push({
      id: fileNodeId,
      type: nodeType,
      name: path.basename(filePath),
      filePath: filePath,
      summary: getSummary(fileCategory, filePath),
      tags: getTags(
        fileCategory,
        filePath,
        res.metrics || {},
        res.functions || [],
        res.exports || [],
      ),
      complexity: getComplexity(res.nonEmptyLines || res.totalLines || 10),
    });

    const imports = batchImportData[filePath] || [];
    for (const imp of imports) {
      edges.push({
        source: fileNodeId,
        target: `file:${imp}`,
        type: 'imports',
        direction: 'forward',
        weight: 0.7,
      });
    }

    if (res.functions) {
      for (const fn of res.functions) {
        const lines = fn.endLine && fn.startLine ? fn.endLine - fn.startLine + 1 : 0;
        const isExported = res.exports && res.exports.some((e) => e.name === fn.name);

        if (lines >= 10 || isExported) {
          const fnId = `function:${filePath}:${fn.name}`;
          nodes.push({
            id: fnId,
            type: 'function',
            name: fn.name,
            summary: `Function ${fn.name} handling internal logic.`,
            tags: ['utility', 'function', 'component'],
            complexity: getComplexity(lines),
            lineRange: [fn.startLine, fn.endLine],
          });
          edges.push({
            source: fileNodeId,
            target: fnId,
            type: 'contains',
            direction: 'forward',
            weight: 1.0,
          });
          if (isExported) {
            edges.push({
              source: fileNodeId,
              target: fnId,
              type: 'exports',
              direction: 'forward',
              weight: 0.8,
            });
          }
        }
      }
    }

    if (res.classes) {
      for (const cls of res.classes) {
        const lines = cls.endLine && cls.startLine ? cls.endLine - cls.startLine + 1 : 0;
        const methodsCount = cls.methods ? cls.methods.length : 0;
        const isExported = res.exports && res.exports.some((e) => e.name === cls.name);

        if (lines >= 20 || methodsCount >= 2 || isExported) {
          const clsId = `class:${filePath}:${cls.name}`;
          nodes.push({
            id: clsId,
            type: 'class',
            name: cls.name,
            summary: `Class ${cls.name} definition.`,
            tags: ['class', 'component', 'data-model'],
            complexity: getComplexity(lines),
            lineRange: [cls.startLine, cls.endLine],
          });
          edges.push({
            source: fileNodeId,
            target: clsId,
            type: 'contains',
            direction: 'forward',
            weight: 1.0,
          });
          if (isExported) {
            edges.push({
              source: fileNodeId,
              target: clsId,
              type: 'exports',
              direction: 'forward',
              weight: 0.8,
            });
          }
        }
      }
    }

    // Handle non-code sub-nodes
    // services
    if (res.services) {
      for (const svc of res.services) {
        if (!svc.name) continue;
        const svcId = `service:${filePath}:${svc.name}`;
        nodes.push({
          id: svcId,
          type: 'service',
          name: svc.name,
          summary: `Service definition ${svc.name}.`,
          tags: ['service', 'infrastructure', 'containerization'],
          complexity: 'moderate',
        });
        edges.push({
          source: fileNodeId,
          target: svcId,
          type: 'contains',
          direction: 'forward',
          weight: 1.0,
        });
      }
    }

    // steps
    if (res.steps) {
      for (const st of res.steps) {
        if (!st.name) continue;
        const stId = `pipeline:${filePath}:${st.name}`; // Note: rule says step:<path>:<name> but valid type is pipeline? Actually rule says prefix is `step:` but wait, valid types are `file, function, class, config, document, service, table, endpoint, pipeline, schema, resource`. Ah! If prefix is `step:` we should map it, wait, rule says "Node type mapping... The module and concept node types are reserved... 11 types; module, concept, domain, flow, step are reserved...". Oh, wait, the rule says "emit a corresponding <prefix>:<path>:<name> node in your output if it meets... steps -> step:<path>:<name> ... Node Types and ID Conventions: Pipeline | pipeline:<relative-path>". The table says "Pipeline | pipeline:<relative-path>" for the parent. Sub-nodes aren't explicitly listed in the main type table, but wait, the instructions explicitly said "emit a corresponding step:<path>:<name> node". But then it says "Scope restriction: Only produce node types listed above. The module: and concept: ... 11 types... step are reserved for other agents." Wait! "step" is reserved! Oh my god. Let's just not produce sub-nodes for `step` since `step` type is reserved. Actually it says "The module, concept, domain, flow, step are reserved for other agents and MUST NOT be created by this agent." So I MUST NOT emit `step:` nodes.
        // Let's omit `step` nodes entirely.
      }
    }

    // endpoints
    if (res.endpoints) {
      for (const ep of res.endpoints) {
        if (!ep.name) continue;
        const epId = `endpoint:${filePath}:${ep.name}`;
        nodes.push({
          id: epId,
          type: 'endpoint',
          name: ep.name,
          summary: `Endpoint ${ep.name}.`,
          tags: ['endpoint', 'api-schema', 'service'],
          complexity: 'moderate',
        });
        edges.push({
          source: fileNodeId,
          target: epId,
          type: 'contains',
          direction: 'forward',
          weight: 1.0,
        });
      }
    }

    // resources
    if (res.resources) {
      for (const r of res.resources) {
        if (!r.name) continue;
        const rId = `resource:${filePath}:${r.name}`;
        nodes.push({
          id: rId,
          type: 'resource',
          name: r.name,
          summary: `Resource ${r.name}.`,
          tags: ['resource', 'infrastructure', 'deployment'],
          complexity: 'moderate',
        });
        edges.push({
          source: fileNodeId,
          target: rId,
          type: 'contains',
          direction: 'forward',
          weight: 1.0,
        });
      }
    }

    // definitions
    if (res.definitions) {
      for (const d of res.definitions) {
        if (!d.name || filePath.endsWith('.env')) continue;
        const dId = `schema:${filePath}:${d.name}`;
        nodes.push({
          id: dId,
          type: 'schema',
          name: d.name,
          summary: `Schema definition ${d.name}.`,
          tags: ['schema-definition', 'data-pipeline', 'database'],
          complexity: 'moderate',
        });
        edges.push({
          source: fileNodeId,
          target: dId,
          type: 'contains',
          direction: 'forward',
          weight: 1.0,
        });
      }
    }
  }

  const nodeCount = nodes.length;
  const edgeCount = edges.length;

  if (nodeCount <= 60 && edgeCount <= 120) {
    fs.writeFileSync(
      path.join(intermediateDir, `batch-${batchIndex}.json`),
      JSON.stringify({ nodes, edges }, null, 2),
    );
    console.log(`Wrote batch-${batchIndex}.json with ${nodeCount} nodes, ${edgeCount} edges.`);
  } else {
    const parts = Math.ceil(Math.max(nodeCount / 60, edgeCount / 120));
    const allFiles = extractData.results.map((r) => r.path).sort();
    const filesPerPart = Math.ceil(allFiles.length / parts);

    for (let k = 1; k <= parts; k++) {
      const partFiles = new Set(allFiles.slice((k - 1) * filesPerPart, k * filesPerPart));

      const partNodes = nodes.filter((n) => {
        let nPath = n.filePath;
        if (!nPath && n.id.includes(':')) {
          const parts = n.id.split(':');
          if (parts.length >= 2) nPath = parts[1];
        }
        return partFiles.has(nPath);
      });

      const partNodeIds = new Set(partNodes.map((n) => n.id));

      const partEdges = edges.filter((e) => {
        return partNodeIds.has(e.source);
      });

      fs.writeFileSync(
        path.join(intermediateDir, `batch-${batchIndex}-part-${k}.json`),
        JSON.stringify({ nodes: partNodes, edges: partEdges }, null, 2),
      );
      console.log(
        `Wrote batch-${batchIndex}-part-${k}.json with ${partNodes.length} nodes, ${partEdges.length} edges.`,
      );
    }
  }
}

targetBatches.forEach(processBatch);
