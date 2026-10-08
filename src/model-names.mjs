// Reviewed against the public OpenRouter catalog and publisher model cards on
// 2026-10-08. Exact names extend recognition without guessing unknown families.
const reviewed = new Set([
 'agents-a1','atria-dawn-preview','dots-3-note-preview','inkling','inkling-small',
 'laguna-s-2.1','laguna-xs-2.1','lfm-2.5-2.6b',
 'ling-3.0-flash-fin','ling-3.0-flash-sante','ling-3.0-flash-vl',
 'mimo-v2.6-flash','muse-glimmer-30b','muse-spark-1.2','muse-spark-1.3',
 'muse-spark-1.2-contributor','muse-spark-1.3-contributor',
 'nex-n2.5-mini','nex-n2.5-pro','north-mini-code','solar-pro4',
 'step-3.5-flash','step-3.7-flash','sensenova-6.8-flash-lite',
 'doubao-seed-2.0-mini','ternary-bonsai-2-27b','diffusiongemma-26b-a4b-it'
]);
const aliases = new Map([
 ['kimi-2.6','kimi-k2.6'],['kimi-2.7-code','kimi-k2.7-code'],
 ['gemma-4-31b','gemma-4-31b-it'],
 ['diffusiongemma-26b-a4b','diffusiongemma-26b-a4b-it'],
 ['nemotron-3-ultra','nemotron-3-ultra-550b-a55b'],
 ['prismml-bonsai-2-27b','ternary-bonsai-2-27b']
]);
export function removeModelDecorations(id) {
 id=id.replace(/^(?:\[(?:nv|or|g|官纯)\]\s*)+/,'');
 const variant=id.match(/^(?:假流式|抗截断|防截断)-/)?.[0]||'';
 if(variant)id=id.slice(variant.length);
 id=id.replace(/:(?:free|batch)$/,'');
 // These Gemini options change a station's handling, not the model version.
 if(id.startsWith('gemini-'))id=id.replace(/(?:-(?:cache|maxthinking|nothinking|search))+$/,'');
 if(/^muse-spark-\d+\.\d+-contributor-free$/.test(id))id=id.slice(0,-5);
 return variant+(aliases.get(id)||id);
}
export const modelCore=id=>id.replace(/^(?:假流式|抗截断|防截断)-/,'');
export const reviewedModel=id=>reviewed.has(id);
export function modelExclusion(value) {
 const id=removeModelDecorations(String(value||'').toLowerCase().split('/').at(-1));
 if(/(?:embed(?:ding)?|rerank(?:er)?|(?:^|\/)bge-)/.test(id))return '嵌入或重排模型，需要专用接口，暂不加入聊天目录。';
 if(/(?:^|-)asr(?:-|$)|(?:^|-)tts(?:-|$)|(?:^|-)realtime(?:-|$)/.test(id))return '语音专用模型，需要专用接口，暂不加入聊天目录。';
 if(/^grok-imagine-|^step-image-/.test(removeModelDecorations(id)))return '图片或视频生成模型，需要专用接口，暂不加入聊天目录。';
 return null;
}
export function mappingState(model) {
 if(model.canonical_id)return {state:'mapped',reason:model.canonical_source==='manual'?'已手动归并。':'已自动归并。'};
 if(model.canonical_source==='manual')return {state:'hidden',reason:'已手动隐藏；刷新站点目录不会自动恢复。'};
 const exclusion=modelExclusion(model.model_id);
 if(exclusion)return {state:'non_chat',reason:exclusion};
 return {state:'unrecognized',reason:'官方型号尚未确认，按原名保留为酒馆中的独立选项。'};
}
export function directoryModelID(model) {
 if(model.canonical_id)return model.canonical_id;
 if(model.canonical_source==='manual'||modelExclusion(model.model_id))return null;
 return model.model_id;
}
