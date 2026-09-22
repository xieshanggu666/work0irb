/**
 * 存档管理：手动槽位 1-3 + 自动槽位；载入/保存/导出/导入/删除
 */
import { useRef, useState } from 'react';
import { FG } from '../../engine';
import { useModal } from '../ModalContext.jsx';
import { ModalShell } from './ModalShell.jsx';

const SLOT_IDS = ['1', '2', '3', 'auto'];

export default function SaveLoadModal({ game }) {
  const modal = useModal();
  // version 用于操作后刷新槽位信息
  const [, setVersion] = useState(0);
  const refresh = () => setVersion(v => v + 1);
  const fileRefs = useRef({});

  function load(id) {
    game.loadSlot(id);
    modal.close();
  }
  function save(id) {
    game.saveTo(id, null);
    refresh();
  }
  function del(id) {
    FG.Save.deleteSlot(id);
    if (game.saveInfo.slot === id) game.saveInfo.slot = null;
    refresh();
  }
  function exportSave(id) { FG.Save.exportSlot(id); }
  function importSave(id, file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const obj = FG.Save.importText(String(reader.result));
      if (!obj) { alert('导入失败：无效的存档文件'); return; }
      FG.Save.saveToSlot(
        id,
        obj.meta || { name: '导入存档', playTime: 0, date: new Date().toLocaleString('zh-CN') },
        obj.data,
      );
      refresh();
    };
    reader.readAsText(file);
  }

  const slots = FG.Save.listSlots();
  const all = SLOT_IDS.map(id => slots.find(x => x.id === id) || { id, exists: false });

  return (
    <ModalShell title="💾 存档管理">
      <div style={{ color: 'var(--text-dim)', fontSize: 11, marginBottom: 10 }}>
        自动存档每 {FG.Config.AUTOSAVE_SEC}s 写入「auto」槽位。可导出 JSON 备份或导入恢复。
      </div>
      {all.map(info => (
        <div className="save-row" key={info.id}>
          <div className="sr-info">
            {info.exists ? (
              <>
                <div className="sr-name">{info.meta.name || '存档'}</div>
                <div className="sr-meta">
                  槽位 {info.id} · 游戏时间 {FG.Utils.fmtTime(info.meta.playTime || 0)} · {info.meta.date || ''}
                </div>
              </>
            ) : (
              <div className="sr-empty">槽位 {info.id} · 空</div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            <button disabled={!info.exists} onClick={() => load(info.id)}>载入</button>
            <button onClick={() => save(info.id)}>保存</button>
            <button disabled={!info.exists} onClick={() => exportSave(info.id)}>导出</button>
            <button className="danger" disabled={!info.exists} onClick={() => del(info.id)}>删除</button>
            <label className="sl-import" style={{ cursor: 'pointer' }}>
              <input
                type="file" accept=".json" hidden
                ref={(el) => (fileRefs.current[info.id] = el)}
                onChange={(e) => { importSave(info.id, e.target.files[0]); e.target.value = ''; }}
              />
              导入
            </label>
          </div>
        </div>
      ))}
    </ModalShell>
  );
}
