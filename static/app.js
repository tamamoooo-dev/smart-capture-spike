let records=[];let pending=null;
const fields=['homework','assignments','quizzes','attendance','projects'];
const labels={homework:'الواجب',assignments:'التكليفات',quizzes:'الاختبارات',attendance:'الحضور',projects:'المشاريع'};
const toast=(message)=>{const el=document.querySelector('#toast');el.textContent=message;el.classList.add('show');setTimeout(()=>el.classList.remove('show'),2200)};
const value=(v)=>v===null||v===undefined?'—':v;
function render(filter=''){
 const body=document.querySelector('#rows');body.innerHTML='';
 records.filter(r=>r.student.includes(filter)).forEach(r=>{
  const tr=document.createElement('tr');
  tr.innerHTML=`<td>${r.student_id}</td><td>${r.student}</td><td class="score">${value(r.participation)}</td>${fields.map(f=>`<td class="editable ${r[f]===null?'missing':''}" data-id="${r.student_id}" data-field="${f}">${value(r[f])}</td>`).join('')}<td><strong>${value(r.final_grade)}</strong></td>`;
  body.appendChild(tr);
 });
 document.querySelector('#studentCount').textContent=records.length;
 const p=records.map(r=>r.participation).filter(v=>v!==null);document.querySelector('#participationAverage').textContent=p.length?(p.reduce((a,b)=>a+b,0)/p.length).toFixed(1):'—';
 document.querySelector('#missingCount').textContent=records.reduce((n,r)=>n+fields.filter(f=>r[f]===null).length,0);
}
async function load(){records=await fetch('/api/register').then(r=>r.json());render()}
document.querySelector('#rows').addEventListener('click',async e=>{
 const td=e.target.closest('.editable');if(!td)return;const current=td.textContent==='—'?'':td.textContent;const next=prompt(`أدخل ${labels[td.dataset.field]}`,current);if(next===null)return;
 const response=await fetch(`/api/grades/${td.dataset.id}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({[td.dataset.field]:next})});
 if(response.ok){const updated=await response.json();records=records.map(r=>r.student_id===updated.student_id?updated:r);render(document.querySelector('#search').value);toast('تم تحديث الدرجة الإلكترونية')}
});
document.querySelector('#search').addEventListener('input',e=>render(e.target.value));
document.querySelector('#save').onclick=()=>fetch('/api/save',{method:'POST'}).then(()=>toast('تم حفظ السجل'));
document.querySelector('#scanFile').addEventListener('change',async e=>{const file=e.target.files[0];if(!file)return;toast('جارٍ تحليل الورقة…');const data=new FormData();data.append('scan',file);const response=await fetch('/api/scan',{method:'POST',body:data});const result=await response.json();if(!response.ok){toast(result.error||'تعذر تحليل المسح');return}pending=result;const changes=result.merge_previews.reduce((n,p)=>n+p.changes.length,0),conflicts=result.merge_previews.reduce((n,p)=>n+p.conflicts.length,0);document.querySelector('#mergeText').textContent=`فُك ترميز ${result.scan.decoded} من ${result.scan.total}. ${changes} قيم مشاركة جديدة و${conflicts} تعارضات. لن يتغير شيء قبل التأكيد.`;document.querySelector('#merge').classList.remove('hidden');document.querySelector('#lastScan').textContent=`${Math.round(result.scan.decode_rate*100)}%`});
document.querySelector('#cancelMerge').onclick=()=>{pending=null;document.querySelector('#merge').classList.add('hidden')};
document.querySelector('#confirmMerge').onclick=async()=>{if(!pending)return;const conflicts=pending.merge_previews.some(p=>p.conflicts.length);if(conflicts&&!confirm('توجد تعارضات في المشاركة. هل تريد اعتماد الورق بصفته المالك؟'))return;const response=await fetch('/api/merge/apply',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({participation:pending.scan.participation,confirm_conflicts:conflicts})});records=(await response.json()).records;pending=null;document.querySelector('#merge').classList.add('hidden');render();toast('تم الدمج بعد التأكيد')};
document.querySelector('#whatsapp').onclick=()=>window.open(`https://wa.me/?text=${encodeURIComponent('ملخص السجل الصفي A1 جاهز للمراجعة.')}`,'_blank');
document.querySelector('#parents').onclick=()=>toast('قناة أولياء الأمور تحتاج موفر رسائل خارجي؛ لم يُرسل شيء');
document.querySelector('#portal').onclick=()=>toast('بوابة الطالب تحتاج API المدرسة؛ لم تُرسل بيانات');
load();

