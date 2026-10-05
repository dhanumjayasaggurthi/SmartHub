import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow, ReactFlowProvider, Background, Controls, Handle, Position, MarkerType, useReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { KIND, FRAGMENT, canvasLayout, stageSubtitle } from './streamsetsModel';

const FIT = { padding: 0.12, maxZoom: 1, minZoom: 0.55, duration: 0 };   // never fit so small the text can't be read
const EDGE = { data: '#9aa5b1', event: '#b3a89f', hot: '#11567f' };
const colorOf = (stage) => (stage.fragment ? FRAGMENT.color : (KIND[stage.kind] || KIND.PROCESSOR).color);
const kindLabel = (stage) => (stage.fragment ? 'Fragment' : (KIND[stage.kind] || KIND.PROCESSOR).label);

const handleStyle = { width: 8, height: 8, background: '#ffffff', border: '1.5px solid #9aa5b1' };

function StageNode({ data }) {
  const { stage, selected, live } = data;
  const color = colorOf(stage);
  return (
    <div className={`w-full h-full rounded-lg border bg-white ${selected ? 'border-[#11567f] ring-2 ring-[#11567f]/20' : 'border-[#d5dbe1] hover:border-[#9aa5b1]'}`}>
      <Handle type="target" position={Position.Left} style={handleStyle} isConnectable={false} />
      <div className="flex h-full">
        <span className="w-[4px] rounded-l-lg flex-shrink-0" style={{ background: color }} />
        <div className="flex-1 min-w-0 px-3 py-2.5">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-semibold" style={{ color }}>{kindLabel(stage)}</span>
            {live && <span className="ml-auto w-1.5 h-1.5 rounded-full bg-[#11567f] motion-safe:animate-pulse" aria-label="Extracting" />}
          </div>
          <div className="mt-0.5 text-[13px] font-medium text-[#1b1f24] truncate" title={stage.label}>{stage.label}</div>
          <div className="text-[11.5px] text-[#57606a] truncate">{stageSubtitle(stage)}</div>
        </div>
      </div>
      <Handle type="source" position={Position.Right} style={handleStyle} isConnectable={false} />
    </div>
  );
}

function FragmentNode({ data }) {
  const { stage, selected, expanded, onToggle, onSelect, selectedPath } = data;
  const frag = stage.fragment;
  const inner = frag.stages || [];
  return (
    <div className={`w-full h-full rounded-lg border bg-white flex flex-col ${selected ? 'border-[#11567f] ring-2 ring-[#11567f]/20' : 'border-[#cdb9e6] hover:border-[#6b3fa0]'}`}>
      <Handle type="target" position={Position.Left} style={{ ...handleStyle, borderColor: '#6b3fa0' }} isConnectable={false} />
      <div className="rounded-t-lg px-3 py-2" style={{ background: FRAGMENT.bg }}>
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold" style={{ color: FRAGMENT.color }}>
            Fragment{frag.version ? ` ${frag.version}` : ''}
          </span>
          <span className="ml-auto text-[11px]" style={{ color: (KIND[stage.kind] || KIND.PROCESSOR).color }}>
            {(KIND[stage.kind] || KIND.PROCESSOR).label}
          </span>
        </div>
        <div className="mt-0.5 text-[13px] font-medium text-[#1b1f24] truncate" title={stage.label}>{stage.label}</div>
        <div className="text-[11.5px] text-[#57606a] truncate" title={frag.name}>{frag.name}</div>
      </div>
      {frag.error ? (
        <div className="px-3 py-1.5 text-[11.5px] text-[#c02b2b] truncate" title={frag.error}>Couldn&apos;t load its stages</div>
      ) : (
        <button type="button" className="nodrag nopan text-left px-3 py-1.5 text-[12px] text-[#6b3fa0] hover:bg-[#faf7fd]"
          onClick={(e) => { e.stopPropagation(); onToggle(stage.instance); }} aria-expanded={expanded}>
          {expanded ? 'Hide' : 'Show'} {inner.length} stage{inner.length === 1 ? '' : 's'} inside
        </button>
      )}
      {expanded && !frag.error && (
        <div className="nodrag nopan px-2 pb-2 space-y-1 overflow-hidden">
          {inner.length === 0 && <div className="px-1 text-[11.5px] text-[#8b949e]">No stages</div>}
          {inner.map((s, i) => {
            const path = `${stage.instance}/${s.instance}`;
            return (
              <React.Fragment key={s.instance}>
                {i > 0 && <div className="h-[4px] ml-[13px] border-l border-dashed border-[#cdb9e6]" aria-hidden="true" />}
                <button type="button" onClick={(e) => { e.stopPropagation(); onSelect(path); }}
                  className={`w-full h-[26px] flex items-center gap-2 px-2 rounded text-left text-[12px] ${selectedPath === path ? 'bg-[#eaf3f9] text-[#11567f]' : 'hover:bg-[#f6f8fa]'}`}>
                  <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: colorOf(s) }} />
                  <span className="truncate">{s.label}</span>
                  <span className="ml-auto text-[11px] text-[#8b949e] flex-shrink-0 max-w-[90px] truncate">{s.fragment ? 'Fragment' : s.technology}</span>
                </button>
              </React.Fragment>
            );
          })}
        </div>
      )}
      <Handle type="source" position={Position.Right} style={{ ...handleStyle, borderColor: '#6b3fa0' }} isConnectable={false} />
    </div>
  );
}

const nodeTypes = { stage: memo(StageNode), fragment: memo(FragmentNode) };

function Canvas({ detail, selectedPath, onSelect, live }) {
  const [expanded, setExpanded] = useState(() => new Set());
  const { fitView } = useReactFlow();
  const selectedTop = (selectedPath || '').split('/')[0];

  const toggle = useCallback((id) => setExpanded(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  }), []);

  // A stage picked inside a fragment (list, parameter, link) opens that fragment here.
  useEffect(() => {
    if (!selectedPath || !selectedPath.includes('/')) return;
    setExpanded(prev => (prev.has(selectedTop) ? prev : new Set(prev).add(selectedTop)));
  }, [selectedPath, selectedTop]);

  const layout = useMemo(() => canvasLayout(detail.stages, expanded), [detail.stages, expanded]);

  const nodes = useMemo(() => layout.nodes.map(n => ({
    id: n.id,
    type: n.stage.fragment ? 'fragment' : 'stage',
    position: { x: n.x, y: n.y },
    width: n.w,
    height: n.h,
    style: { width: n.w, height: n.h },
    draggable: false,
    selectable: false,
    data: {
      stage: n.stage,
      selected: selectedTop === n.id && !selectedPath.includes('/'),
      expanded: expanded.has(n.id),
      selectedPath,
      live,
      onToggle: toggle,
      onSelect,
    },
  })), [layout, selectedTop, selectedPath, expanded, live, toggle, onSelect]);

  const edges = useMemo(() => layout.edges.map(e => {
    const hot = selectedTop && (e.source === selectedTop || e.target === selectedTop);
    const color = hot ? EDGE.hot : EDGE[e.kind];
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      type: 'default',
      animated: live && e.kind === 'data',
      label: e.kind === 'event' ? 'event' : undefined,
      labelStyle: { fontSize: 11, fill: '#6e6259' },
      labelBgStyle: { fill: '#ffffff' },
      labelBgPadding: [4, 2],
      style: { stroke: color, strokeWidth: hot ? 2.2 : 1.6, strokeDasharray: e.kind === 'event' ? '5 4' : undefined },
      markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 },
      zIndex: hot ? 1 : 0,
    };
  }), [layout, selectedTop, live]);

  // Keep the pipeline fitted as the space changes (stage panel, run panel, window size, a fragment
  // opening) - until the user pans or zooms, after which the view is theirs.
  const wrapRef = useRef(null);
  const userMoved = useRef(false);
  const refit = useCallback(() => { if (!userMoved.current) fitView(FIT); }, [fitView]);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    let frame = 0;
    const ro = new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(refit); });
    ro.observe(el);
    return () => { cancelAnimationFrame(frame); ro.disconnect(); };
  }, [refit]);
  useEffect(() => {
    const frame = requestAnimationFrame(refit);
    return () => cancelAnimationFrame(frame);
  }, [layout, refit]);
  const fitNow = () => { userMoved.current = false; fitView(FIT); };

  const fragmentIds = useMemo(() => detail.stages.filter(s => s.fragment && !s.fragment.error).map(s => s.instance), [detail.stages]);

  return (
    <div ref={wrapRef} className="relative w-full h-full ss-canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={(_, node) => onSelect(node.id)}
        onPaneClick={() => selectedPath && onSelect(selectedPath)}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        onlyRenderVisibleElements
        minZoom={0.2}
        maxZoom={1.6}
        zoomOnDoubleClick={false}
        onMoveStart={(event) => { if (event) userMoved.current = true; }}
        fitView
        fitViewOptions={FIT}
      >
        <Background gap={20} size={1} color="#dfe3e8" />
        <Controls showInteractive={false} showFitView={false} position="bottom-left" />
      </ReactFlow>

      <div className="absolute top-3 left-3 flex items-center gap-1 rounded-md border border-[#e4e8ec] bg-white px-1 py-1 text-[12px]">
        {fragmentIds.length > 0 && (<>
          <button type="button" className="px-2 py-0.5 rounded text-[#57606a] hover:bg-[#eef1f4]" onClick={() => { userMoved.current = false; setExpanded(new Set(fragmentIds)); }}>Open fragments</button>
          <button type="button" className="px-2 py-0.5 rounded text-[#57606a] hover:bg-[#eef1f4]" onClick={() => { userMoved.current = false; setExpanded(new Set()); }}>Close fragments</button>
        </>)}
        <button type="button" className="px-2 py-0.5 rounded text-[#57606a] hover:bg-[#eef1f4]" onClick={fitNow}>Fit to screen</button>
      </div>

      <div className="absolute top-3 right-3 flex items-center gap-3 rounded-md border border-[#e4e8ec] bg-white px-2.5 py-1.5 text-[11.5px] text-[#57606a]" aria-hidden="true">
        <span className="inline-flex items-center gap-1.5">
          <svg width="22" height="6"><path d="M0 3h22" stroke={EDGE.data} strokeWidth="1.6" /></svg>Records
        </span>
        <span className="inline-flex items-center gap-1.5">
          <svg width="22" height="6"><path d="M0 3h22" stroke={EDGE.event} strokeWidth="1.6" strokeDasharray="5 4" /></svg>Events
        </span>
      </div>
    </div>
  );
}

export default function PipelineCanvas(props) {
  return (
    <ReactFlowProvider>
      <style>{`
        .ss-canvas .react-flow__node { cursor: pointer; }
        .ss-canvas .react-flow__controls { box-shadow: none; border: 1px solid #e4e8ec; border-radius: 6px; overflow: hidden; }
        @media (prefers-reduced-motion: reduce) { .ss-canvas .react-flow__edge.animated path { animation: none; } }
      `}</style>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}