// Publishes sanitized session state for UI renderers; no auth or conversation bodies.
export function installChatStateFile(fs, path, resources, store) {
 const file=path.join(resources,'inspector-chat-state.json');
 const save=()=>{
   const temp=file+'.tmp';
   for(const p of [file,temp])if(fs.existsSync(p)&&fs.lstatSync(p).isSymbolicLink())throw Error('Invalid state path');
   fs.writeFileSync(temp,JSON.stringify({schema:1,records:store.snapshot()}),{encoding:'utf8',flag:'w'});
   fs.renameSync(temp,file);
 };
 save(); // Clear a previous process session, never imply historical values are current.
 return record=>{store.accept(record);save();};
}
