import { build } from 'esbuild';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
// Resolve the audited all-relative module graph explicitly. No ancestor directory scans.
export const bundle = options => build({absWorkingDir:process.cwd(),tsconfigRaw:{},bundle:true,format:'esm',platform:'browser',target:'es2022',
  plugins:[{name:'relative-source',setup(b){
    b.onResolve({filter:/.*/}, args=>{
      if(!args.path.startsWith('.') && !path.isAbsolute(args.path))throw new Error('Non-relative dependency: '+args.path);
      return {path:path.resolve(args.importer?path.dirname(args.importer):process.cwd(),args.path.split('?')[0]),namespace:'source'};
    });
    b.onLoad({filter:/.*/,namespace:'source'},async args=>({contents:await readFile(args.path,'utf8'),loader:'js'}));
  }}],...options});
