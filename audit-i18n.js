#!/usr/bin/env node
/**
 * Auditoria de traduções — AI Strategy Hub
 *
 * Compara os textos-fonte em português com os dicionários externos
 * en.json / de.json, e reporta três categorias de divergência:
 *
 *   - AUSENTES:       a chave existe em PT mas nunca foi traduzida.
 *   - DESATUALIZADAS: a chave foi traduzida, mas o texto em PT mudou depois
 *                     (o hash do PT atual não bate com o sourceHash salvo).
 *   - ÓRFÃS:          a chave existe no dicionário traduzido mas não existe
 *                     mais no código-fonte (provavelmente removida do PT).
 *
 * O texto-fonte em português vem de duas origens distintas no index.html:
 *
 *   1. Arrays de dados (cases[], canonBlocks[], archetypeInfo, ECOSYSTEM,
 *      matrixData, ARCHETYPES) — o texto é o próprio valor do campo, não um
 *      literal na chamada tx(). Este script carrega o script do app numa
 *      sandbox (vm) e lê esses arrays diretamente, com a MESMA convenção de
 *      chaves usada nas chamadas tx() dentro das funções de renderização
 *      (ver Especificacao-Arquitetura-i18n-v1.md, §4).
 *   2. Literais — chamadas tx('texto', 'chave') com string fixa (badges,
 *      labels) e atributos estáticos data-i18n="chave" data-i18n-pt="texto"
 *      (nav, cabeçalho, modais, callout) — extraídos por regex do HTML bruto.
 *
 * Uso: node audit-i18n.js
 * Ferramenta de desenvolvimento — não roda no navegador nem faz parte do app.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML_PATH = path.join(__dirname, 'index.html');
const LOCALES = { en: 'i18n/en.json', de: 'i18n/de.json' };

// Hash simples e determinístico (djb2) — impressão digital do conteúdo em PT, não criptográfico.
// Nota para quem gerar hashes fora do Node (ex.: Python): esta função itera por UNIDADES
// UTF-16 (como charCodeAt), não por codepoints Unicode. Caracteres fora do plano básico
// multilíngue (ex.: emoji 💡) viram par substituto (2 unidades) — uma implementação em
// Python que itere por codepoints (ord()) produz hash diferente para esses casos;
// codifique para UTF-16LE e itere par de bytes para replicar exatamente esta função.
function hash(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) {
        h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(16);
}

function extractLiteralStrings(html) {
    const map = {};
    let m;

    const reTx = /tx\(\s*(['"`])((?:\\.|(?!\1).)*)\1\s*,\s*(['"`])((?:\\.|(?!\3).)*)\3\s*\)/g;
    while ((m = reTx.exec(html))) {
        // Interpreta as sequências de escape (\n, \t, \\, \') para casar com a string que o JS
        // realmente monta em runtime — senão um rótulo com '\n' no código não bateria com o
        // newline real recebido por tx(), quebrando busca de tradução e hash de auditoria.
        const text = m[2]
            .replace(/\\n/g, '\n')
            .replace(/\\t/g, '\t')
            .replace(/\\(['"`\\])/g, '$1');
        map[m[4]] = text;
    }

    const reStatic = /<[a-z][^>]*?data-i18n="([^"]+)"[^>]*?data-i18n-pt="((?:[^"\\]|\\.)*)"[^>]*>/gi;
    while ((m = reStatic.exec(html))) map[m[1]] = m[2];

    const reStaticRev = /<[a-z][^>]*?data-i18n-pt="((?:[^"\\]|\\.)*)"[^>]*?data-i18n="([^"]+)"[^>]*>/gi;
    while ((m = reStaticRev.exec(html))) { if (!(m[2] in map)) map[m[2]] = m[1]; }

    const reHtml = /<(p|span|h[1-6]|ul|li|div|summary)\b[^>]*?data-i18n="([^"]+)"[^>]*?data-i18n-html="1"[^>]*>([\s\S]*?)<\/\1>/gi;
    while ((m = reHtml.exec(html))) { if (!(m[2] in map)) map[m[2]] = m[3].trim(); }

    return map;
}

function extractDataStrings(html) {
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
        .map(mm => mm[1]).filter(s => s.trim().length > 50);
    const appScript = scripts[scripts.length - 1];

    const store = {};
    function makeEl(id) {
        const el = {
            id, value: '50', className: '', dataset: {}, style: {}, children: [], textContent: '', innerText: '', innerHTML: '',
            classList: { _s: new Set(), add(c){this._s.add(c);}, remove(c){this._s.delete(c);}, toggle(){}, contains(c){return this._s.has(c);} },
            appendChild(c){ this.children.push(c); }, querySelectorAll(){return [];}, querySelector(){return null;},
            addEventListener(){}, setAttribute(){}, getContext(){return {};}, scrollIntoView(){}, remove(){}
        };
        return el;
    }
    const doc = {
        getElementById(id){ return store[id] || (store[id] = makeEl(id)); },
        querySelectorAll(){ return []; }, querySelector(){ return null; },
        createElement(t){ return makeEl(t); }, addEventListener(){}, body: makeEl('body')
    };
    function ChartStub(c, cfg){ this.data = cfg && cfg.data; this.update = () => {}; this.destroy = () => {}; }
    const sandbox = {
        document: doc,
        window: { innerWidth: 1200, addEventListener(){}, matchMedia(){ return { matches:false, addListener(){} }; } },
        console: { log(){}, warn(){}, error(){} },
        setTimeout: (f) => { if (typeof f === 'function') f(); },
        performance: { now: () => 0 }, requestAnimationFrame: () => 1, cancelAnimationFrame(){},
        marked: { parse: x => x }, fetch: () => Promise.resolve({ json: () => ({}) }),
        localStorage: { getItem(){return null;}, setItem(){}, }, navigator: { language: 'pt-BR' },
        URLSearchParams: URLSearchParams, history: { replaceState(){} }
    };
    sandbox.window.Chart = ChartStub; sandbox.Chart = ChartStub;
    sandbox.window.location = { search: '' };
    vm.createContext(sandbox);
    vm.runInContext(appScript + `
;globalThis.__cases = (typeof cases !== 'undefined') ? cases : null;
globalThis.__canonBlocks = (typeof canonBlocks !== 'undefined') ? canonBlocks : null;
globalThis.__archetypeInfo = (typeof archetypeInfo !== 'undefined') ? archetypeInfo : null;
globalThis.__ARCH_SHORT = (typeof ARCH_SHORT !== 'undefined') ? ARCH_SHORT : null;
globalThis.__ECOSYSTEM = (typeof ECOSYSTEM !== 'undefined') ? ECOSYSTEM : null;
globalThis.__matrixData = (typeof matrixData !== 'undefined') ? matrixData : null;
globalThis.__IMPACT_HEADERS = (typeof IMPACT_HEADERS !== 'undefined') ? IMPACT_HEADERS : null;
globalThis.__IMPACT_MATRIX = (typeof IMPACT_MATRIX !== 'undefined') ? IMPACT_MATRIX : null;
`, sandbox, { timeout: 8000 });

    const map = {};

    if (sandbox.__cases) {
        sandbox.__cases.forEach(c => {
            map['cases.' + c.id + '.name'] = c.name;
            map['cases.' + c.id + '.desc'] = c.desc;
        });
    }
    if (sandbox.__canonBlocks) {
        sandbox.__canonBlocks.forEach(b => {
            map['canon.' + b.id + '.title'] = b.title;
            map['canon.' + b.id + '.text'] = b.text;
        });
    }
    if (sandbox.__archetypeInfo) {
        Object.entries(sandbox.__archetypeInfo).forEach(([key, info]) => {
            map['archetypes.' + key + '.tagline'] = info.tagline;
            map['archetypes.' + key + '.desc'] = info.desc;
            map['archetypes.' + key + '.examples'] = info.examples;
            if (sandbox.__ARCH_SHORT && sandbox.__ARCH_SHORT[key]) {
                map['archetypes.' + key + '.name'] = sandbox.__ARCH_SHORT[key];
            }
        });
    }
    if (sandbox.__ECOSYSTEM) {
        Object.entries(sandbox.__ECOSYSTEM).forEach(([id, e]) => {
            map['ecosystem.' + id + '.sp'] = e.sp;
            map['ecosystem.' + id + '.kr'] = e.kr;
            map['ecosystem.' + id + '.role'] = e.role;
        });
    }
    if (sandbox.__matrixData) {
        Object.entries(sandbox.__matrixData).forEach(([toolId, data]) => {
            if (!data.justifications) return;
            Object.entries(data.justifications).forEach(([capId, text]) => {
                map['matrix.' + toolId + '.' + capId] = text;
            });
        });
    }
    if (sandbox.__IMPACT_HEADERS) {
        sandbox.__IMPACT_HEADERS.forEach((head, hi) => {
            map['impacto.header.' + hi] = head;
        });
    }
    if (sandbox.__IMPACT_MATRIX) {
        const domKeys = ['think', 'disc', 'design', 'build', 'integ'];
        sandbox.__IMPACT_MATRIX.forEach((row, ri) => {
            row.cells.forEach((cell, ci) => {
                map['impacto.cell.' + domKeys[ri] + '.' + ci] = cell.text;
            });
        });
    }

    return map;
}

function loadDict(relPath) {
    const full = path.join(__dirname, relPath);
    if (!fs.existsSync(full)) {
        console.warn(`  ⚠ arquivo não encontrado: ${relPath} (tratando como dicionário vazio)`);
        return {};
    }
    return JSON.parse(fs.readFileSync(full, 'utf8'));
}

function truncate(s, n) { return s.length > n ? s.slice(0, n) + '…' : s; }

// Detector de texto em português que NÃO passa por tx() nem data-i18n — o ponto cego
// que fazia "zero divergências" não significar "cobertura completa". Heurística, não perfeita:
// pode gerar falsos positivos (nomes próprios, siglas), mas cobre o vetor real de escape.
function findUnmarkedPortuguese(html) {
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(mm => mm[1]);
    const appScript = scripts.reduce((a, b) => b.length > a.length ? b : a, '');
    const htmlPart = html.replace(appScript, '');

    // Sinal de PT: acento, ou "ç", ou palavra funcional que difere do inglês.
    const ptSignal = /[áàâãéêíóôõúüçÁÀÂÃÉÊÍÓÔÕÚÜÇ]|\b(não|são|está|você|também|até|então|após|já|só|é)\b/;

    const findings = [];

    // (1) HTML: nós de texto sem data-i18n. Para reduzir falsos positivos, ignora texto que
    // esteja DENTRO de um elemento com data-i18n-html="1" (onde o PT é fallback legítimo e a
    // tradução do bloco inteiro já existe) — busca num ancestral próximo, não só na tag imediata.
    for (const m of htmlPart.matchAll(/>([^<>]{3,300})</g)) {
        const t = m[1].trim();
        if (t.length < 3 || !ptSignal.test(t)) continue;
        // Janela de contexto ampla para trás, para achar um data-i18n-html de bloco.
        const wide = htmlPart.slice(Math.max(0, m.index - 1200), m.index);
        // Se há um data-i18n-html="1" aberto e ainda não fechou seu </p>/</div>/</h_> depois dele, é bloco traduzido.
        const lastHtmlMark = wide.lastIndexOf('data-i18n-html');
        if (lastHtmlMark !== -1) {
            const afterMark = wide.slice(lastHtmlMark);
            // heurística simples: se depois do marcador ainda não veio a tag de fechamento do bloco, estamos dentro dele
            if (!/<\/(p|div|h[1-6]|ul|li|summary)>/.test(afterMark)) continue;
        }
        const ctx = wide.slice(wide.lastIndexOf('<'));
        if (ctx.includes('data-i18n')) continue;
        findings.push({ where: 'HTML', text: t });
    }

    // (2) JS: strings literais PT que não são o 1º argumento de tx(...)
    const strRe = /(['"`])((?:\\.|(?!\1).){4,200}?)\1/g;
    let sm;
    while ((sm = strRe.exec(appScript))) {
        const s = sm[2];
        if (!ptSignal.test(s)) continue;
        const before = appScript.slice(Math.max(0, sm.index - 5), sm.index);
        if (/tx\(\s*$/.test(before)) continue;               // é o texto-fonte de tx(): ok
        if (s.startsWith('.') || s.startsWith('#')) continue; // seletor CSS
        // ignora se a string é um VALOR conhecido de arrays de dados (matrixData/ECOSYSTEM/etc.)
        // — esses são text-fonte de tx() em outro ponto; para reduzir ruído, só reportamos
        // strings que aparecem em contexto de atribuição a .textContent/.innerHTML/.innerText/label.
        const after = appScript.slice(sm.index + sm[0].length, sm.index + sm[0].length + 3);
        const ctxBefore = appScript.slice(Math.max(0, sm.index - 60), sm.index);
        const looksLikeUiSink = /(textContent|innerHTML|innerText|\.label|label:|placeholder|title:|\+\s*$|=\s*$|return\s*$|\?\s*$|:\s*$)/.test(ctxBefore);
        if (!looksLikeUiSink) continue;
        findings.push({ where: 'JS', text: s });
    }

    return findings;
}

function audit() {
    if (!fs.existsSync(HTML_PATH)) {
        console.error(`index.html não encontrado em ${HTML_PATH}`);
        process.exit(1);
    }

    const html = fs.readFileSync(HTML_PATH, 'utf8');
    const ptMap = { ...extractDataStrings(html), ...extractLiteralStrings(html) };
    const ptKeys = Object.keys(ptMap);

    console.log(`\nChaves de texto-fonte encontradas (dados + literais): ${ptKeys.length}`);

    let totalIssues = 0;

    for (const [lang, relPath] of Object.entries(LOCALES)) {
        const dict = loadDict(relPath);
        const dictKeys = Object.keys(dict);
        const missing = [];
        const stale = [];
        const orphan = [];

        for (const key of ptKeys) {
            const entry = dict[key];
            if (!entry) { missing.push(key); continue; }
            const currentHash = hash(ptMap[key]);
            if (entry.sourceHash !== currentHash) stale.push(key);
        }
        for (const key of dictKeys) {
            if (!(key in ptMap)) orphan.push(key);
        }

        totalIssues += missing.length + stale.length + orphan.length;

        console.log(`\n=== ${lang.toUpperCase()}  (${relPath}) ===`);
        console.log(`  Ausentes: ${missing.length}   Desatualizadas: ${stale.length}   Órfãs: ${orphan.length}`);
        if (missing.length) { console.log(`\n  Ausentes:`); missing.forEach(k => console.log(`    - ${k}`)); }
        if (stale.length) {
            console.log(`\n  Desatualizadas:`);
            stale.forEach(k => console.log(`    - ${k}\n        PT atual: "${truncate(ptMap[k], 70)}"`));
        }
        if (orphan.length) { console.log(`\n  Órfãs:`); orphan.forEach(k => console.log(`    - ${k}`)); }
    }

    console.log(`\n${'─'.repeat(50)}`);
    console.log(totalIssues === 0
        ? 'Nenhuma divergência encontrada nas chaves marcadas. ✅'
        : `Total de divergências encontradas: ${totalIssues} ⚠`);
    console.log(`${'─'.repeat(50)}`);

    // Ponto cego coberto: texto PT que nunca foi marcado (não aparece como divergência acima
    // justamente por nunca ter virado uma chave). Heurístico — revisar manualmente.
    const unmarked = findUnmarkedPortuguese(html);
    console.log(`\nTexto PT possivelmente NÃO instrumentado (heurístico): ${unmarked.length}`);
    if (unmarked.length) {
        unmarked.slice(0, 60).forEach(f => console.log(`    [${f.where}] ${truncate(f.text, 90)}`));
        if (unmarked.length > 60) console.log(`    … e mais ${unmarked.length - 60}`);
        console.log('  (heurístico: alguns podem ser falsos positivos — nomes próprios, siglas, texto-fonte de tx())');
    }
    console.log('');

    process.exit(totalIssues === 0 ? 0 : 1);
}

audit();