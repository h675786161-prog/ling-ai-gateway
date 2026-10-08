const limit=600;
export function redactError(value,secrets=[],sensitive=[]) {
 let text=typeof value==='string'?value.slice(0,8192):'';
 for(const secret of secrets)if(typeof secret==='string'&&secret.length)text=text.split(secret).join('[已隐藏]');
 for(const value of sensitive)if(typeof value==='string'&&value.length>=4)text=text.split(value).join('[已隐藏]');
 text=text.replace(/\b(?:sk|lg|sb_secret|sb_publishable)[_-][a-z0-9_-]{8,}/gi,'[密钥已隐藏]')
  .replace(/\bBearer\s+[^\s,;"'}]+/gi,'Bearer [已隐藏]')
  .replace(/\beyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+/gi,'[令牌已隐藏]')
  .replace(/((?:api[_-]?key|access[_-]?token|authorization|password|secret|token)["']?\s*[=:]\s*["']?)[^\s,"';&}]+/gi,'$1[已隐藏]')
  .replace(/https?:\/\/[^\s<>"']+/gi,'[地址已隐藏]')
  .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,' ').replace(/\s+/g,' ').trim();
 // Do not retain upstream echoes of prompts, request payloads, or stack traces.
 if(/"(?:messages|input|prompt|content|tool_calls)"\s*:|\b(?:traceback|stack trace)\b/i.test(text))return '上游返回了包含请求内容或调试信息的错误，原文已隐藏。';
 return text.replaceAll('<','‹').replaceAll('>','›').slice(0,limit);
}
export function errorObject(data,{secrets=[],sensitive=[]}={}) {
 const source=data?.error??data;
 if(typeof source==='string')return {upstream_code:null,upstream_message:redactError(source,secrets,sensitive)||null};
 if(!source||typeof source!=='object')return {upstream_code:null,upstream_message:null};
 const code=source.code??source.type??source.status;
 return {upstream_code:typeof code==='string'||typeof code==='number'?redactError(String(code),secrets,sensitive).slice(0,120)||null:null,
  upstream_message:redactError(source.message??source.detail??source.msg,secrets,sensitive)||null};
}
export async function readUpstreamError(response,options={}) {
 const reader=response.body?.getReader();if(!reader)return errorObject(null);let size=0,buffer='';const decoder=new TextDecoder(),timer=setTimeout(()=>reader.cancel().catch(()=>{}),2000);
 try {while(true){const item=await reader.read();if(item.done)break;size+=item.value.length;if(size>16384)break;buffer+=decoder.decode(item.value,{stream:true});}return errorObject(JSON.parse(buffer),options);}
 catch{return errorObject(null);}finally{clearTimeout(timer);await reader.cancel().catch(()=>{});}
}
export function describeFailure(result={}) {
 const status=result.http_status??result.status??0,reason=result.reason||'',detail=((result.upstream_code||'')+' '+(result.upstream_message||'')).toLowerCase();
 if(reason==='cancelled')return '请求已停止；未把它算作模型故障。';
 if(reason==='cooldown_or_quota')return '线路正在冷却，或站内每日/每分钟额度已用完。';
 if(reason==='request_deadline')return '本次云端等待时间已用完，尚未轮到这条线路。';
 if((reason==='timeout'||reason==='thinking_timeout')&&result.status==='partial')return '上游已经返回正文，但在本次云端时限内尚未完成；已经收到的文字仍保留。';
 if(reason==='timeout'||reason==='thinking_timeout')return (result.reasoning_received||reason==='thinking_timeout'?'上游已在思考，但':'上游')+(result.wait_seconds?'在 '+result.wait_seconds+' 秒内':'在等待时限内')+'没有返回正文。';
 if(reason==='stream_interrupted')return '上游连接在回复完成前断开，已经收到的文字仍保留。';
 if(reason==='response_too_large')return '上游返回了过大的单条数据，网关停止读取。';
 if(reason==='empty_response')return '上游请求成功，但没有返回正文或工具调用。';
 if(/insufficient_quota|no.credit|insufficient.*(?:balance|credit)|balance.*(?:insufficient|exhaust)|余额|欠费/.test(detail))return '上游账户余额或可用总额度不足，需要等额度恢复或检查账户。';
 if(/(?:daily|per.day|requests.per.day|\brpd\b).*(?:limit|quota|exceed|exhaust)|(?:quota|limit).*(?:daily|per.day)|每日.*(?:额度|上限)|日额度/.test(detail))return '这个上游的每日额度已用完，需要等它重置或换线路。';
 if(/context.*(?:length|window|limit|exceed)|too.many.*(?:input|prompt).*token|maximum.*context|上下文.*(?:过长|超|长度)/.test(detail))return '这次聊天上下文超过上游模型上限，请减少历史消息或换上下文更长的模型。';
 if(/(?:max_tokens|max_completion_tokens|max_output_tokens|output.*token).*(?:large|greater|maximum|exceed|limit|range)/.test(detail))return '酒馆设置的输出长度超过这个上游允许的上限，请降低最大回复长度。';
 if(/content[_ .-]?(?:filter|policy|violation)|safety|moderation|内容.*(?:审核|限制|拒绝)/.test(detail))return '上游的内容检查拒绝了这次请求。';
 if(/model.*(?:not.found|not.exist|not.available|not.allowed|unsupported)|unknown.model|模型.*(?:不存在|无权限|不可用)/.test(detail))return '上游没有提供这个模型，或当前密钥无权调用它。';
 if(/invalid.api.key|invalid.token|expired.token|revoked|密钥.*(?:错误|无效|失效)/.test(detail)||status===401)return '上游密钥无效、过期或被撤销，请到“我的线路”检查密钥。';
 if(status===403)return '上游拒绝访问：可能是模型权限、账户权限或站点的访问规则。';
 if(status===402)return '上游账户余额不足或要求付费。';
 if(status===404)return '上游找不到模型或这个请求接口。';
 if(status===429||/rate.limit|too.many.requests|resource.exhausted|限流/.test(detail))return '上游请求太频繁，或当前速率额度已用完，请稍后重试。';
 if(/quota.exhaust|quota.exceed/.test(detail))return '上游可用额度已用完，具体额度周期请查看上游说明。';
 if(/(?:tools?|function.call).*(?:unsupported|not.support)|(?:unsupported|not.support).*(?:tools?|function.call)/.test(detail))return '上游不支持这次请求使用的工具调用。';
 if(status===400||status===405||status===422)return '上游不接受这次请求的参数或接口格式。';
 if(status>=500)return '上游服务繁忙或发生内部错误，可以稍后重试或换线路。';
 if(reason==='upstream_error')return '上游返回了无效数据或在回复中报错。';
 return '无法连接上游，或上游连接意外断开。';
}
export function failureDiagnostic(result) {
 return {summary_zh:describeFailure(result),http_status:result.http_status||0,reason:result.reason||null,
  upstream_code:result.upstream_code||null,upstream_message:result.upstream_message||null,
  reasoning_received:!!result.reasoning_received,wait_seconds:result.wait_seconds||null,
  ...(result.retry_after>0?{retry_after:result.retry_after}:{})};
}
export function allFailedMessage(model,results) {
 const details=results.slice(0,8).map(r=>redactError(r.provider_name||'线路')+'：'+describeFailure(r)+(r.http_status?'（HTTP '+r.http_status+'）':'')+(r.upstream_message?' 上游说明：'+r.upstream_message.slice(0,180):''));
 return redactError(model)+' 暂未拿到有效回复。'+details.join('；')+(results.length>8?'；其他线路详情请看调用记录。':'');
}
