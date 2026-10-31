"""Run a local command with a minimal environment and durable, hash-bound evidence."""
import hashlib,json,os,subprocess,sys,time
from pathlib import Path

root=Path(__file__).resolve().parents[1]
label,*command=sys.argv[1:]
if not label.replace('-','').replace('_','').isalnum() or not command:raise SystemExit('label and command required')
evidence=root/'docs/validation/p8-p10/evidence';evidence.mkdir(parents=True,exist_ok=True)
env={k:os.environ[k] for k in ['PATH','HOME','TMPDIR','LANG'] if k in os.environ}
runtime=root/'.runtime'/label;runtime.mkdir(parents=True,exist_ok=True,mode=0o700)
env['TMPDIR']=str(runtime.resolve())
env.update(ALLOW_TEST_LIVE='off',OPENAI_AGENTS_DISABLE_TRACING='1',DO_NOT_TRACK='1')
start=time.time()
log=evidence/(label+'.txt')
with log.open('w') as f:
 result=subprocess.run(command,cwd=root,env=env,stdout=f,stderr=subprocess.STDOUT)
record={'command':command,'cwd':str(root),'exit_code':result.returncode,'elapsed_seconds':round(time.time()-start,3),'source_sha':subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip(),'dirty_paths':subprocess.check_output(['git','status','--porcelain'],cwd=root,text=True).splitlines(),'environment':'E1_local_synthetic_no_paid_credentials','log_ref':str(log.relative_to(root)),'log_sha256':hashlib.sha256(log.read_bytes()).hexdigest()}
(evidence/(label+'.json')).write_text(json.dumps(record,indent=2)+'\n')
print(json.dumps(record));print(log.read_text()[-5000:]);raise SystemExit(result.returncode)
