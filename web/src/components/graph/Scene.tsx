import { Billboard, Line, OrbitControls } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { color } from "@/lib/tokens";
import type { DeviceView, Finding, PlaceView, Severity } from "@core/types";
import { deviceTitle, placeName, placeSummary, shapeFor, type Shape } from "@/lib/view";

const PLATE = 5.2;
const SLAB = 0.16;
const GAP = 3.4;
const GOLDEN_ANGLE = 2.399963;
const SCALE_DBM = [-50, -70, -90];
const MAX_NEEDLE = 1.5;
const MAC_NEEDLE = 2.1;
const FULL_NEEDLE_MINUTES = 480;
const MAX_FINDING_LABELS = 6;
const RIPPLE_SECONDS = 1.8;
const FILM_LIFT = 72;
const COMPACT_WIDTH = 640;
const TAN_HALF_FOV = Math.tan((26 / 2) * (Math.PI / 180));

interface Props {
  places: PlaceView[];
  devices: DeviceView[];
  findings: Finding[];
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  film: boolean;
  reducedMotion: boolean;
  /** Pixels of the stage covered by the inspector. */
  inset: number;
}

/** Distance from the plate's centre is signal strength, so closer means nearer you. */
function signalRadius(rssi: number): number {
  const t = THREE.MathUtils.clamp((-35 - rssi) / 60, 0, 1);
  return 0.8 + t * 3.8;
}

/** Height is time heard. Log scale, so a passer-by and a neighbour's TV both stay readable. */
function needleHeight(minutes: number): number {
  const t = Math.min(Math.log1p(minutes) / Math.log1p(FULL_NEEDLE_MINUTES), 1);
  return 0.2 + t * MAX_NEEDLE;
}

function devicePosition(device: DeviceView): [number, number] {
  const radius = signalRadius(Math.max(...device.presence.map((p) => p.bestRssi), -100));
  const angle = device.id * GOLDEN_ANGLE;
  return [Math.cos(angle) * radius, Math.sin(angle) * radius];
}

function plateY(index: number, count: number): number {
  return ((count - 1) / 2 - index) * GAP;
}

function outline(shape: Shape, scale: number): THREE.Vector2[] {
  const r = scale;
  if (shape === "square") {
    const s = r * 0.86;
    return [[-s, -s], [s, -s], [s, s], [-s, s]].map(([x, y]) => new THREE.Vector2(x, y));
  }
  if (shape === "diamond") {
    const s = r * 1.25;
    return [[0, -s], [s, 0], [0, s], [-s, 0]].map(([x, y]) => new THREE.Vector2(x, y));
  }
  if (shape === "triangle") {
    return [[0, r * 1.15], [r * 1.08, -r * 0.8], [-r * 1.08, -r * 0.8]].map(
      ([x, y]) => new THREE.Vector2(x, y),
    );
  }
  return Array.from({ length: 40 }, (_, i) => {
    const a = (i / 40) * Math.PI * 2;
    return new THREE.Vector2(Math.cos(a) * r, Math.sin(a) * r);
  });
}

const geometries = new Map<string, THREE.BufferGeometry>();

function shapeGeometry(shape: Shape, hollow: boolean): THREE.BufferGeometry {
  const key = `${shape}-${hollow}`;
  const cached = geometries.get(key);
  if (cached) return cached;
  const body = new THREE.Shape(outline(shape, 1));
  if (hollow) body.holes.push(new THREE.Path(outline(shape, 0.62)));
  const geometry = new THREE.ShapeGeometry(body);
  geometries.set(key, geometry);
  return geometry;
}

function circlePoints(radius: number): [number, number, number][] {
  return Array.from({ length: 97 }, (_, i) => {
    const a = (i / 96) * Math.PI * 2;
    return [Math.cos(a) * radius, 0, Math.sin(a) * radius];
  });
}

function squarePoints(): [number, number, number][] {
  return [
    [-PLATE, 0, -PLATE],
    [PLATE, 0, -PLATE],
    [PLATE, 0, PLATE],
    [-PLATE, 0, PLATE],
    [-PLATE, 0, -PLATE],
  ];
}

const CORNER_SIGNS = [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const;

/** One corner bracket, in plate coordinates. */
function cornerPoints(sx: number, sz: number): [number, number, number][] {
  const arm = 1.1;
  const x = sx * PLATE;
  const z = sz * PLATE;
  return [
    [x - sx * arm, 0, z],
    [x, 0, z],
    [x, 0, z - sz * arm],
  ];
}

function shadowTexture(): THREE.Texture {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (context) {
    // Drawn off-canvas so only the blurred shadow lands, which works in every browser.
    context.shadowColor = "rgba(16, 22, 33, 1)";
    context.shadowBlur = 34;
    context.shadowOffsetX = size * 2;
    context.fillRect(44 - size * 2, 44, size - 88, size - 88);
  }
  return new THREE.CanvasTexture(canvas);
}

function Plate({ place, y, opacity, grounded }: { place: PlaceView; y: number; opacity: number; grounded: boolean }) {
  const border = useMemo(squarePoints, []);
  const rings = useMemo(() => SCALE_DBM.map((dbm) => circlePoints(signalRadius(dbm))), []);
  const shadow = useMemo(() => (grounded ? shadowTexture() : null), [grounded]);
  const faces = [color.sideDark, color.sideDark, color.surface, color.surface, color.sideLight, color.sideLight];
  const reach = signalRadius(-95);
  return (
    <group position={[0, y, 0]}>
      {shadow && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0.5, -1.15, 0.5]} scale={1.5} renderOrder={-4}>
          <planeGeometry args={[PLATE * 2, PLATE * 2]} />
          <meshBasicMaterial map={shadow} transparent opacity={0.16} depthWrite={false} />
        </mesh>
      )}
      <mesh position={[0, -SLAB / 2, 0]} renderOrder={-3}>
        <boxGeometry args={[PLATE * 2, SLAB, PLATE * 2]} />
        {faces.map((face, index) => (
          <meshBasicMaterial key={index} attach={`material-${index}`} color={face} transparent opacity={opacity} depthWrite={false} />
        ))}
      </mesh>
      <group position={[0, 0.006, 0]}>
        <Line points={border} color={place.current ? color.ink : color.ruleStrong} lineWidth={place.current ? 1.1 : 0.9} />
        {rings.map((points, index) => (
          <Line key={SCALE_DBM[index]} points={points} color={color.rule} lineWidth={0.9} />
        ))}
        <Line points={[[-reach, 0, 0], [reach, 0, 0]]} color={color.rule} lineWidth={0.7} />
        <Line points={[[0, 0, -reach], [0, 0, reach]]} color={color.rule} lineWidth={0.7} />
      </group>
    </group>
  );
}

/** Corner brackets only, so an empty plate reads as a reserved spot and not an object. */
function ReservedPlate({ y }: { y: number }) {
  const corners = useRef<(THREE.Group | null)[]>([]);
  // The corner nearest the camera would land on the plate below, and which one that is
  // changes as the graph orbits.
  useFrame(({ camera }) => {
    CORNER_SIGNS.forEach(([sx, sz], index) => {
      const corner = corners.current[index];
      if (corner) corner.visible = !(Math.sign(camera.position.x) === sx && Math.sign(camera.position.z) === sz);
    });
  });
  return (
    <group position={[0, y, 0]}>
      {CORNER_SIGNS.map(([sx, sz], index) => (
        <group
          key={`${sx}${sz}`}
          ref={(group) => {
            corners.current[index] = group;
          }}
        >
          <Line points={cornerPoints(sx, sz)} color={color.ink3} lineWidth={1} />
        </group>
      ))}
    </group>
  );
}

/** This Mac stands at the centre of the plate it is on, taller than anything it hears. */
function ThisMac({ y }: { y: number }) {
  return (
    <group position={[0, y, 0]}>
      <Line points={[[0, 0, 0], [0, MAC_NEEDLE, 0]]} color={color.you} lineWidth={1.4} />
      <Billboard position={[0, MAC_NEEDLE, 0]}>
        <mesh scale={0.11} renderOrder={2}>
          <circleGeometry args={[1, 32]} />
          <meshBasicMaterial color={color.you} transparent depthWrite={false} />
        </mesh>
      </Billboard>
    </group>
  );
}

interface MarkerProps {
  device: DeviceView;
  position: [number, number, number];
  tone: string;
  size: number;
  filled: boolean;
  opacity: number;
  onSelect: (id: number) => void;
  onHover: (id: number | null) => void;
}

function Marker({ device, position, tone, size, filled, opacity, onSelect, onHover }: MarkerProps) {
  const shape = shapeFor(device.class);
  return (
    <Billboard position={position}>
      <mesh
        scale={Math.max(size * 2.2, 0.24)}
        onClick={(event) => {
          event.stopPropagation();
          onSelect(device.id);
        }}
        onPointerOver={(event) => {
          event.stopPropagation();
          onHover(device.id);
          document.body.style.cursor = "pointer";
        }}
        onPointerOut={() => {
          onHover(null);
          document.body.style.cursor = "";
        }}
      >
        <circleGeometry args={[1, 12]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      {!filled && (
        <mesh geometry={shapeGeometry(shape, false)} scale={size} renderOrder={1}>
          <meshBasicMaterial color={color.surface} transparent opacity={opacity} depthWrite={false} />
        </mesh>
      )}
      <mesh geometry={shapeGeometry(shape, !filled)} scale={size} renderOrder={2}>
        <meshBasicMaterial color={tone} transparent opacity={opacity} depthWrite={false} />
      </mesh>
    </Billboard>
  );
}

/** Ambient motion is reserved for a live high-severity device. */
function Pulse({ position }: { position: [number, number, number] }) {
  const mesh = useRef<THREE.Mesh>(null);
  const material = useRef<THREE.MeshBasicMaterial>(null);
  useFrame(({ clock, invalidate }) => {
    const t = (clock.elapsedTime % 2.4) / 2.4;
    mesh.current?.scale.setScalar(0.22 + t * 0.5);
    if (material.current) material.current.opacity = (1 - t) * 0.5;
    invalidate();
  });
  return (
    <Billboard position={position}>
      <mesh ref={mesh}>
        <ringGeometry args={[0.92, 1, 48]} />
        <meshBasicMaterial ref={material} color={color.alert} transparent depthWrite={false} />
      </mesh>
    </Billboard>
  );
}

const flatRing = new THREE.RingGeometry(0.96, 1, 64).rotateX(-Math.PI / 2);

/** Runs once when a device is first heard, like a drop landing on the plate. */
function Ripple({ position, onDone }: { position: [number, number, number]; onDone: () => void }) {
  const mesh = useRef<THREE.Mesh>(null);
  const material = useRef<THREE.MeshBasicMaterial>(null);
  const started = useRef<number | null>(null);
  useFrame(({ clock, invalidate }) => {
    started.current ??= clock.elapsedTime;
    const t = (clock.elapsedTime - started.current) / RIPPLE_SECONDS;
    if (t >= 1) {
      onDone();
      return;
    }
    const eased = 1 - (1 - t) ** 4;
    mesh.current?.scale.setScalar(0.08 + eased * 0.85);
    if (material.current) material.current.opacity = (1 - t) * 0.8;
    invalidate();
  });
  return (
    <mesh ref={mesh} geometry={flatRing} position={position} scale={0.08}>
      <meshBasicMaterial ref={material} color={color.ink} transparent opacity={0} depthWrite={false} />
    </mesh>
  );
}

const footGeometry = new THREE.CircleGeometry(0.035, 12).rotateX(-Math.PI / 2);
const footMaterial = new THREE.MeshBasicMaterial({ color: color.ruleStrong });

function Feet({ points }: { points: [number, number, number][] }) {
  const mesh = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    const matrix = new THREE.Matrix4();
    points.forEach(([x, y, z], index) => {
      matrix.makeTranslation(x, y + 0.008, z);
      mesh.current?.setMatrixAt(index, matrix);
    });
    if (mesh.current) mesh.current.instanceMatrix.needsUpdate = true;
  }, [points]);
  return <instancedMesh ref={mesh} args={[footGeometry, footMaterial, points.length]} frustumCulled={false} />;
}

/** Frames the stack so the plate labels fit too, whatever shape the stage is. */
function Rig({ stack, lookY }: { stack: number; lookY: number }) {
  const { camera, size, invalidate } = useThree();
  useEffect(() => {
    const aspect = size.width / Math.max(size.height, 1);
    // Compact stages drop the plate labels, so they don't need to leave room for them.
    const margin = size.width < COMPACT_WIDTH ? 0.8 : 4.2;
    const byWidth = (PLATE * Math.SQRT2 + margin) / (TAN_HALF_FOV * aspect);
    const byHeight = (4.9 + stack) / TAN_HALF_FOV;
    const reach = Math.max(byWidth, byHeight);
    const target = new THREE.Vector3(0, lookY, 0);
    camera.position.copy(new THREE.Vector3(1, 0.74, 1).normalize().multiplyScalar(reach).add(target));
    camera.lookAt(target);
    invalidate();
  }, [camera, stack, lookY, size.width, size.height, invalidate]);
  return null;
}

/**
 * Slides the picture instead of moving the camera, so the framing and the orbit
 * stay as they were. The label projection picks this up from the same matrix.
 */
function ViewShift({ x, y, instant }: { x: number; y: number; instant: boolean }) {
  const invalidate = useThree((state) => state.invalidate);
  const current = useRef({ x: 0, y: 0 });

  useEffect(() => invalidate(), [x, y, invalidate]);

  useFrame(({ camera, size, invalidate: again }) => {
    const shift = current.current;
    const follow = instant ? 1 : 0.16;
    shift.x += (x - shift.x) * follow;
    shift.y += (y - shift.y) * follow;
    const settled = Math.abs(x - shift.x) < 0.5 && Math.abs(y - shift.y) < 0.5;
    if (settled) {
      shift.x = x;
      shift.y = y;
    } else {
      again();
    }
    if (camera instanceof THREE.PerspectiveCamera) {
      camera.setViewOffset(size.width, size.height, shift.x, shift.y, size.width, size.height);
    }
  });

  return null;
}

interface Stop {
  y: number;
  head: number;
}

interface Item {
  device: DeviceView;
  stops: Stop[];
  x: number;
  z: number;
  level: Severity | undefined;
  mine: boolean;
  tone: string;
}

function buildModel(places: PlaceView[], devices: DeviceView[], findings: Finding[]) {
  const plates = places.length;
  const slots = plates === 1 ? 2 : plates;
  const offset = plates === 1 ? 1 : 0;
  const yByPlace = new Map(places.map((place, index) => [place.id, plateY(index + offset, slots)]));
  const severity = new Map(findings.map((finding) => [finding.deviceId, finding.severity]));
  // A note about something that has left stays in the list, not on the graph.
  const live = new Set(devices.filter((device) => device.live).map((device) => device.id));
  const labelled = new Set(
    findings
      .filter((finding) => finding.severity !== "note" || live.has(finding.deviceId))
      .slice(0, MAX_FINDING_LABELS)
      .map((finding) => finding.deviceId),
  );

  const items = devices.flatMap((device): Item[] => {
    const stops = device.presence.flatMap((presence) => {
      const y = yByPlace.get(presence.placeId);
      return y === undefined ? [] : [{ y, head: y + needleHeight(presence.minutes) }];
    });
    if (stops.length === 0) return [];
    const [x, z] = devicePosition(device);
    const level = severity.get(device.id);
    const mine = device.owner?.self === true;
    const unidentified = shapeFor(device.class) === "triangle" && !level;
    const tone = level === "high" ? color.alert : mine ? color.you : unidentified ? color.ink3 : color.ink;
    return [{ device, stops, x, z, level, mine, tone }];
  });

  // With one place the reserved plate sits above it, so frame the real plate and let that trail off.
  const lookY = plates === 1 ? plateY(1, 2) + 1.1 : -0.3;
  // How much further back the camera sits, on top of what one plate needs.
  const stack = plates === 1 ? GAP * 0.42 : (plates - 1) * GAP * 0.62;
  return { plates, slots, offset, items, labelled, lookY, stack, inRange: live.size };
}

type Model = ReturnType<typeof buildModel>;

/** Every needle in one draw call. They fade into the plate at the foot. */
function buildNeedles(items: Item[], selectedId: number | null) {
  const surface = new THREE.Color(color.surface);
  const points: [number, number, number][] = [];
  const colors: [number, number, number][] = [];
  const feet: [number, number, number][] = [];
  for (const { device, stops, x, z, tone } of items) {
    const dimmed = selectedId !== null && device.id !== selectedId;
    const fade = dimmed ? 0.9 : device.live ? 0.12 : 0.55;
    const top = new THREE.Color(tone).lerp(surface, fade);
    const foot = new THREE.Color(tone).lerp(surface, Math.max(fade, 0.72));
    for (const { y, head } of stops) {
      points.push([x, y, z], [x, head, z]);
      colors.push([foot.r, foot.g, foot.b], [top.r, top.g, top.b]);
      feet.push([x, y, z]);
    }
  }
  return { points, colors, feet };
}

interface GraphProps extends Props {
  model: Model;
  onHover: (id: number | null) => void;
}

function Graph({ places, model, selectedId, onSelect, onHover, film, reducedMotion, inset }: GraphProps) {
  const { plates, slots, offset, items, lookY, stack } = model;
  const needles = useMemo(() => buildNeedles(items, selectedId), [items, selectedId]);
  const here = places.findIndex((place) => place.current);
  return (
    <>
      <Rig stack={stack} lookY={lookY} />
      <ViewShift x={inset / 2} y={film ? FILM_LIFT : 0} instant={reducedMotion} />
      {places.map((place, index) => (
        <Plate
          key={place.id}
          place={place}
          y={plateY(index + offset, slots)}
          opacity={plates === 1 ? 1 : 0.8}
          grounded={index === plates - 1}
        />
      ))}
      {plates === 1 && <ReservedPlate y={plateY(0, slots)} />}
      {here >= 0 && <ThisMac y={plateY(here + offset, slots)} />}

      {needles.feet.length > 0 && <Feet key={needles.feet.length} points={needles.feet} />}
      {needles.points.length > 0 && (
        <Line
          key={needles.points.length}
          points={needles.points}
          vertexColors={needles.colors}
          segments
          color="#ffffff"
          lineWidth={1}
        />
      )}

      {items.map(({ device, stops, x, z, level, mine, tone }) => {
        const selected = device.id === selectedId;
        const dimmed = selectedId !== null && !selected;
        const prominent = level !== undefined && (device.live || level !== "note");
        const opacity = dimmed ? 0.14 : device.live || prominent ? 1 : 0.5;
        const size = level === "high" ? 0.16 : selected ? 0.14 : prominent ? 0.12 : 0.066;
        const heads = stops.map((stop) => stop.head);
        const bottom = Math.min(...stops.map((stop) => stop.y));
        const top = Math.max(...heads);
        return (
          <group key={device.id}>
            {stops.length > 1 && (
              <Line
                points={[[x, bottom, z], [x, top, z]]}
                color={tone}
                lineWidth={level === "high" ? 2.4 : selected ? 2 : 1.1}
                transparent
                opacity={dimmed ? 0.12 : mine ? 0.5 : 1}
                dashed={device.identityConfidence < 1}
                dashSize={0.16}
                gapSize={0.11}
              />
            )}
            {heads.map((head) => (
              <Marker
                key={head}
                device={device}
                position={[x, head, z]}
                tone={tone}
                size={size}
                filled={device.live || mine || level === "high"}
                opacity={opacity}
                onSelect={onSelect}
                onHover={onHover}
              />
            ))}
            {level === "high" && device.live && !reducedMotion && <Pulse position={[x, top, z]} />}
          </group>
        );
      })}

      <OrbitControls
        target={[0, lookY, 0]}
        enablePan={false}
        enableDamping={!reducedMotion}
        dampingFactor={0.08}
        minPolarAngle={0.5}
        maxPolarAngle={1.5}
        minDistance={9}
        maxDistance={80}
        autoRotate={film && !reducedMotion}
        autoRotateSpeed={0.45}
        makeDefault
      />
    </>
  );
}

interface Anchor {
  key: string;
  position: [number, number, number];
  text: string;
  detail?: string;
  tone?: "alert" | "ink" | "you";
  kind: "plate" | "callout" | "scale";
  current?: boolean;
  ghost?: boolean;
  /** Pixels between the anchor and the callout, before any collision nudge. */
  leader?: number;
  /** Shown only because of a finding, so it can go when space is tight. */
  resting?: boolean;
}

function buildAnchors(places: PlaceView[], model: Model, selectedId: number | null, hoverId: number | null): Anchor[] {
  const anchors: Anchor[] = places.map((place, index) => ({
    key: `plate-${place.id}`,
    position: [0, plateY(index + model.offset, model.slots), 0],
    text: placeName(place),
    detail: placeSummary(place, model.inRange),
    kind: "plate",
    current: place.current,
  }));
  if (model.plates === 1) {
    anchors.push({
      key: "reserved",
      position: [0, plateY(0, model.slots), 0],
      text: "Your next place",
      detail: "Anything that comes with you draws a line to here",
      kind: "plate",
      ghost: true,
    });
  }
  places.forEach((place, index) => {
    const y = plateY(index + model.offset, model.slots);
    if (place.current) {
      anchors.push({ key: "this-mac", position: [0, y + MAC_NEEDLE, 0], text: "This Mac", tone: "you", kind: "callout", leader: 8 });
      const across = 1 / Math.SQRT2;
      for (const dbm of SCALE_DBM) {
        const radius = signalRadius(dbm);
        anchors.push({
          key: `scale-${dbm}`,
          position: [radius * across, y, -radius * across],
          text: `${dbm} dBm`,
          kind: "scale",
        });
      }
    }
  });
  for (const { device, stops, x, z, level } of model.items) {
    const selected = device.id === selectedId;
    const resting = selectedId === null && (model.labelled.has(device.id) || device.watched);
    if (!selected && hoverId !== device.id && !resting) continue;
    anchors.push({
      key: `device-${device.id}`,
      position: [x, Math.max(...stops.map((stop) => stop.head)), z],
      text: deviceTitle(device),
      tone: level === "high" ? "alert" : selected ? "ink" : undefined,
      kind: "callout",
      leader: 16,
      resting: resting && !selected && level !== "high",
    });
  }
  return anchors;
}

const TAG_GAP = 3;
const PLATE_CORNERS = [[-PLATE, -PLATE], [PLATE, -PLATE], [PLATE, PLATE], [-PLATE, PLATE]] as const;

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

function overlaps(a: Box, b: Box): boolean {
  return (
    a.left < b.left + b.width &&
    b.left < a.left + a.width &&
    a.top < b.top + b.height &&
    b.top < a.top + a.height
  );
}

/** Keeps the DOM labels pinned to their 3D anchors without re-rendering React. */
function Projector({ anchors, nodes }: { anchors: Anchor[]; nodes: Map<string, HTMLElement> }) {
  const invalidate = useThree((state) => state.invalidate);
  const point = useMemo(() => new THREE.Vector3(), []);

  useEffect(() => invalidate(), [anchors, invalidate]);

  useFrame(({ camera, size }) => {
    const placed: Box[] = [];
    for (const anchor of anchors) {
      const node = nodes.get(anchor.key);
      if (!node) continue;
      point.set(...anchor.position).project(camera);
      const x = ((point.x + 1) / 2) * size.width;
      const y = ((1 - point.y) / 2) * size.height;
      node.style.visibility = "visible";

      if (anchor.kind === "plate") {
        // Beside the plate's left edge, level with its centre. Both move smoothly as the
        // graph orbits, so the label never lands on the plate or jumps between corners.
        let edge = Infinity;
        for (const [cornerX, cornerZ] of PLATE_CORNERS) {
          point.set(cornerX, anchor.position[1], cornerZ).project(camera);
          edge = Math.min(edge, ((point.x + 1) / 2) * size.width);
        }
        const left = Math.max(edge - node.offsetWidth - 16, 10);
        node.style.transform = `translate(${left}px, ${y - node.offsetHeight / 2}px)`;
        continue;
      }
      if (anchor.kind === "scale") {
        node.style.transform = `translate(${x - node.offsetWidth / 2}px, ${y - node.offsetHeight / 2}px)`;
        continue;
      }

      const leader = anchor.leader ?? 0;
      const box: Box = {
        left: x - node.offsetWidth / 2,
        top: y - node.offsetHeight - leader,
        width: node.offsetWidth,
        height: node.offsetHeight,
      };
      for (let tries = 0; tries < 8 && placed.some((other) => overlaps(box, other)); tries += 1) {
        box.top -= box.height + TAG_GAP;
      }
      placed.push(box);
      node.style.setProperty("--leader", `${y - box.top - box.height}px`);
      node.style.transform = `translate(${box.left}px, ${box.top}px)`;
    }
  });

  return null;
}

interface Landing {
  id: number;
  position: [number, number, number];
}

export default function Scene(props: Props) {
  const { places, devices, findings, selectedId, reducedMotion } = props;
  const [hoverId, setHoverId] = useState<number | null>(null);
  const [landings, setLandings] = useState<Landing[]>([]);
  const nodes = useRef(new Map<string, HTMLElement>());
  const known = useRef<Set<number> | null>(null);
  const model = useMemo(() => buildModel(places, devices, findings), [places, devices, findings]);
  const anchors = useMemo(
    () => buildAnchors(places, model, selectedId, hoverId),
    [places, model, selectedId, hoverId],
  );

  // Only devices heard since the page opened, so loading the page doesn't set off every ripple.
  useEffect(() => {
    const previous = known.current;
    known.current = new Set(model.items.map((item) => item.device.id));
    if (!previous || reducedMotion) return;
    const fresh = model.items
      .filter((item) => !previous.has(item.device.id))
      .flatMap(({ device, stops, x, z }): Landing[] => {
        const stop = stops[0];
        return stop ? [{ id: device.id, position: [x, stop.y + 0.012, z] }] : [];
      });
    if (fresh.length > 0) setLandings((current) => [...current, ...fresh]);
  }, [model, reducedMotion]);

  const landed = useCallback((id: number) => {
    setLandings((current) => current.filter((landing) => landing.id !== id));
  }, []);

  return (
    <>
      <Canvas
        flat
        frameloop={props.film ? "always" : "demand"}
        dpr={[1, 2]}
        gl={{ antialias: true, alpha: true }}
        camera={{ fov: 26, near: 0.1, far: 300, position: [14, 11, 14] }}
        onPointerMissed={() => props.onSelect(null)}
        aria-hidden="true"
      >
        <Graph {...props} model={model} onHover={setHoverId} />
        {landings.map((landing) => (
          <Ripple key={landing.id} position={landing.position} onDone={() => landed(landing.id)} />
        ))}
        <Projector anchors={anchors} nodes={nodes.current} />
      </Canvas>
      <div className="graph-labels" data-inset={props.inset > 0} aria-hidden="true">
        {anchors.map((anchor) => (
          <div
            key={anchor.key}
            className="graph-anchor"
            data-resting={anchor.resting}
            ref={(node) => {
              if (node) nodes.current.set(anchor.key, node);
              else nodes.current.delete(anchor.key);
            }}
          >
            {anchor.kind === "callout" && <span className="graph-tag" data-tone={anchor.tone}>{anchor.text}</span>}
            {anchor.kind === "scale" && <span className="scale-label">{anchor.text}</span>}
            {anchor.kind === "plate" && (
              <span className="plate-label" data-current={anchor.current} data-ghost={anchor.ghost}>
                <b>{anchor.text}</b> {anchor.detail}
              </span>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
