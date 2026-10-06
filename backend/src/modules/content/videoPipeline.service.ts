import { promises as fs } from 'node:fs';
import path from 'node:path';
import { prisma } from '../../config/db';
import { env } from '../../config/env';
import { objectStorage } from '../../utils/objectStorage';
import { cleanupTranscodeDir, generateThumbnail, listFiles, transcodeToHls } from '../../utils/videoTranscoder';
import type { Kind } from './types';
const mime=(file:string)=>file.endsWith('.m3u8')?'application/vnd.apple.mpegurl':file.endsWith('.ts')?'video/mp2t':'video/mp4';
export async function processContent(kind:Kind,id:string){
 const db=prisma as any; const content=kind==='VIDEO'?db.video:db.short;
 const row=await content.findUnique({where:{id},select:{id:true,videoKey:true,mimeType:true,width:true,height:true,thumbnailKey:true}});
 if(!row?.videoKey||!row.width||!row.height)return;
 if(env.STORAGE_DRIVER==='memory'){await content.update({where:{id},data:{processingStatus:'READY',processedAt:new Date(),processingError:null,manifestKey:row.videoKey}});return;}
 await content.update({where:{id},data:{processingStatus:'PROCESSING',processingError:null}});
 const work=await fs.mkdtemp(path.join(env.UPLOAD_DIR,'.transcode-')).catch(()=>fs.mkdtemp(path.join('/tmp','f2f-transcode-')));
 const source=path.join(work,'source.'+((row.mimeType||'video/mp4').split('/')[1]||'mp4'));
 try{
  await objectStorage.downloadToFile(row.videoKey,source);
  const thumbnail=path.join(work,'thumbnail.jpg');
  if(!row.thumbnailKey){const key=`${kind==='VIDEO'?'videos':'shorts'}/${id}/thumbnail.jpg`;await generateThumbnail(source,thumbnail);await objectStorage.uploadFile(key,thumbnail,'image/jpeg');await content.update({where:{id},data:{thumbnailKey:key}});}
  const out=await transcodeToHls(source,row.width,row.height);const prefix=`${kind==='VIDEO'?'videos':'shorts'}/${id}/hls`;
  for(const r of out.renditions)for(const f of await listFiles(r.file))await objectStorage.uploadFile(`${prefix}/${f}`,path.join(r.file,f),mime(f));
  const masterPath=path.join(out.dir,'master.m3u8');await fs.writeFile(masterPath,out.master);const masterKey=`${prefix}/master.m3u8`;await objectStorage.uploadFile(masterKey,masterPath,'application/vnd.apple.mpegurl');
  await prisma.$transaction(async tx=>{
   if(kind==='VIDEO'){await tx.videoVariant.deleteMany({where:{videoId:id}});for(const r of out.renditions)await tx.videoVariant.create({data:{contentId:id,height:r.height,width:r.width,bitrateKbps:r.bitrateKbps,objectKey:`${prefix}/${r.height}/index.m3u8`,videoId:id}});await tx.video.update({where:{id},data:{processingStatus:'READY',processedAt:new Date(),processingError:null,manifestKey:masterKey}});}
   else{await tx.videoVariant.deleteMany({where:{shortId:id}});for(const r of out.renditions)await tx.videoVariant.create({data:{contentId:id,height:r.height,width:r.width,bitrateKbps:r.bitrateKbps,objectKey:`${prefix}/${r.height}/index.m3u8`,shortId:id}});await tx.short.update({where:{id},data:{processingStatus:'READY',processedAt:new Date(),processingError:null,manifestKey:masterKey}});}
  });
 }catch(e){await content.update({where:{id},data:{processingStatus:'FAILED',processingError:String((e as Error).message).slice(0,1000)}}).catch(()=>undefined);throw e;}finally{await cleanupTranscodeDir(work);}
}
