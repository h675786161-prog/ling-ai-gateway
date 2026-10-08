import {test} from 'node:test';
import assert from 'node:assert/strict';
import {redactError,errorObject,readUpstreamError,describeFailure,allFailedMessage} from '../src/diagnostics.mjs';

test('Chinese reasons distinguish exhausted balance, request rate, context length, model access and content rejection',()=>{
 const cases=[[429,'insufficient_quota','Your balance is insufficient','余额'],[429,'rate_limit_exceeded','Too many requests','请求太频繁'],[400,'context_length_exceeded','Maximum context length is 32768 tokens','上下文'],[400,'bad_request','max_tokens must be less than the maximum','输出长度'],[403,'model_not_allowed','model is not allowed','模型'],[403,'content_policy_violation','request rejected','内容检查'],[401,'invalid_api_key','token is revoked','密钥'],[503,'busy','upstream overloaded','服务繁忙']];
 for(const [http_status,upstream_code,upstream_message,expected]of cases)assert.ok(describeFailure({http_status,upstream_code,upstream_message}).includes(expected));
 assert.ok(describeFailure({http_status:403}).includes('可能'));assert.ok(describeFailure({reason:'timeout',wait_seconds:90,reasoning_received:true}).includes('已在思考'));
 assert.ok(describeFailure({http_status:429,upstream_code:'quota_exceeded',upstream_message:'Requests per minute quota exceeded'}).includes('请求太频繁'));
 assert.ok(describeFailure({http_status:429,upstream_message:'Daily quota exceeded'}).includes('每日额度'));
 assert.ok(describeFailure({status:'partial',reason:'timeout',wait_seconds:130}).includes('已经返回正文'));
});
test('known keys, generic credentials, JWTs, URLs and exact prompt echoes are removed from retained errors',()=>{
 const secret='unusual-provider-secret-123',prompt='This is private conversation content.',raw='Provider error '+secret+'; '+prompt+'; Bearer unknown-opaque-credential; api_key=another-credential; "password":"password123"; sk-example0123456789; eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signaturesafe; https://user:password@example.org/path?token=secret';
 const safe=redactError(raw,[secret],[prompt]);for(const forbidden of [secret,prompt,'unknown-opaque-credential','another-credential','password123','sk-example0123456789','eyJhbGciOiJIUzI1NiJ9','example.org'])assert.ok(!safe.includes(forbidden),forbidden);assert.ok(safe.includes('隐藏'));
 assert.ok(!redactError('<img src=x onerror=alert(1)>').includes('<'));
});
test('echoed request objects and debug stack traces are not retained as error explanations',()=>{
 for(const raw of ['Failed body: {"messages":[{"content":"private text"}]}','Traceback: stack trace with credentials'])assert.ok(!redactError(raw).includes('private text'));
 assert.equal(errorObject({error:{message:'ordinary useful message',code:'rate_limited'}}).upstream_message,'ordinary useful message');
});
test('HTTP error parsing retains a useful safe JSON detail and ignores HTML error pages',async()=>{
 const detail=await readUpstreamError(Response.json({error:{code:'invalid_api_key',message:'invalid key secret-value-123'}}),{secrets:['secret-value-123']});assert.equal(detail.upstream_code,'invalid_api_key');assert.ok(!detail.upstream_message.includes('secret-value-123'));
 assert.deepEqual(await readUpstreamError(new Response('<html>private debug page</html>')),{upstream_code:null,upstream_message:null});
});
test('error reads are bounded and oversized bodies never become retained diagnostics',async()=>{
 let cancelled=false;const response=new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('x'.repeat(16385)));},cancel(){cancelled=true;}}));
 assert.deepEqual(await readUpstreamError(response),{upstream_code:null,upstream_message:null});assert.equal(cancelled,true);
});
test('Tavern failure message identifies the model and each failed station without exposing HTML',()=>{
 const text=allFailedMessage('step-5-preview',[{provider_name:'slow',http_status:200,reason:'timeout',reasoning_received:true,wait_seconds:90},{provider_name:'denied',http_status:403}]);
 assert.ok(text.includes('step-5-preview'));assert.ok(text.includes('slow：'));assert.ok(text.includes('已在思考'));assert.ok(text.includes('90 秒'));assert.ok(text.includes('HTTP 403'));
});
