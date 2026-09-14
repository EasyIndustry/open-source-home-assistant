// Maqueta 3D de la casa. Estado canónico en el server; acá solo se representa.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/CSS2DRenderer.js';

const H = 2.4;            // altura de paredes
const OX = -9, OZ = -5.5; // centrar la planta en el origen
const C = { cyan: 0x3fd0e0, green: 0x7ee787, amber: 0xffb454, red: 0xff5c5c, mag: 0xd38cff, blue: 0x6aa8ff, line: 0x2a3a48 };

// Planta (metros): [x0, z0, x1, z1]
export const ROOMS = {
  dormitorio: [0, 0, 5, 5], bano: [5, 0, 8, 5], oficina: [8, 0, 12, 5],
  living: [0, 5, 6, 11], comedor: [6, 5, 9, 11], cocina: [9, 5, 12, 11],
  patio: [12, 0, 19, 11],
};
const ROOM_LABEL = { dormitorio: 'dormitorio', bano: 'baño', oficina: 'oficina', living: 'living', comedor: 'comedor', cocina: 'cocina', patio: 'patio' };

// Montaje de dispositivos: posición (planta) + orientación de pared ('x' pared paralela a X, 'z' a Z)
const MOUNT = {
  'ventana.dormitorio': { p: [2.5, 0], wall: 'x' }, 'ventana.bano': { p: [6.5, 0], wall: 'x' },
  'ventana.oficina': { p: [10, 0], wall: 'x' }, 'ventana.living': { p: [1.8, 11], wall: 'x' },
  'ventana.cocina': { p: [10.5, 11], wall: 'x' },
  'persiana.living': { p: [0, 8], wall: 'z' }, 'persiana.comedor': { p: [7.5, 11], wall: 'x' },
  'persiana.dormitorio': { p: [0, 2.5], wall: 'z' }, 'persiana.oficina': { p: [12, 2.5], wall: 'z' },
  'aire.living': { p: [3, 5.12], wall: 'x', dir: 1 }, 'aire.dormitorio': { p: [2.5, 4.88], wall: 'x', dir: -1 },
  'aire.oficina': { p: [10.2, 4.88], wall: 'x', dir: -1 },
  'ventilador.dormitorio': { p: [3.6, 3.2] }, 'ventilador.comedor': { p: [7.5, 8] }, 'ventilador.bano': { p: [7.88, 2.5], wall: 'z' },
  'tele.living': { p: [5.9, 8.2], face: -1 }, 'tele.dormitorio': { p: [4.9, 1.8], face: -1 },
  'enchufe.cocina': { p: [11.6, 7] }, 'enchufe.oficina': { p: [8.4, 0.6] },
  'cerradura.living': { p: [4.3, 11] }, 'porton.patio': { p: [19, 5] }, 'riego.patio': { p: [15.5, 5.5] },
  'alarma.casa': { p: [12, 9.8] },
};
const SAT = { living: [1, 6], cocina: [11.4, 10.2], comedor: [8.6, 5.6], dormitorio: [0.6, 4.4], bano: [5.5, 4.4], oficina: [11.4, 4.4], patio: [13, 10.3] };
const HUB = [9.2, 0.6]; // servidor N100 en la oficina

const w = (x, z, y = 0) => new THREE.Vector3(x + OX, y, z + OZ);

export class House {
  constructor(el, { onClickDevice }) {
    this.el = el;
    this.onClickDevice = onClickDevice;
    this.dev = {};        // id -> { obj, parts, label, state }
    this.roomLabels = {};
    this.anim = [];       // efectos temporales
    this.state = {};
    this.clock = new THREE.Clock();

    const r = this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    r.setPixelRatio(Math.min(devicePixelRatio, 2));
    r.shadowMap.enabled = false;
    el.appendChild(r.domElement);
    this.css = new CSS2DRenderer();
    this.css.domElement.style.cssText = 'position:absolute;inset:0;pointer-events:none';
    el.appendChild(this.css.domElement);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0x07090c, 30, 60);
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 200);
    this.camera.position.set(-3.5, 13.5, 14.5);
    this.controls = new OrbitControls(this.camera, r.domElement);
    this.controls.target.set(0.5, 0, 0);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI / 2.1;

    this.hemi = new THREE.HemisphereLight(0x9fc4ff, 0x10151a, 0.6);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xfff1dd, 0.8);
    this.sun.position.set(10, 20, 6);
    this.scene.add(this.sun);

    this.build();
    this.raycaster = new THREE.Raycaster();
    r.domElement.addEventListener('pointerdown', e => this._down = [e.clientX, e.clientY]);
    r.domElement.addEventListener('pointerup', e => this.click(e));
    r.domElement.addEventListener('pointermove', e => this.hover(e));
    new ResizeObserver(() => this.resize()).observe(el);
    this.resize();
    this.loop();
  }

  // ------------------------------------------------------------ construcción
  build() {
    const s = this.scene;
    const grid = new THREE.GridHelper(60, 60, 0x14202a, 0x0e151c);
    grid.position.y = -0.01;
    s.add(grid);
    this.edgeMat = new THREE.LineBasicMaterial({ color: C.cyan, transparent: true, opacity: 0.55 });
    this.wallMat = new THREE.MeshStandardMaterial({ color: 0x1a2530, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false });

    for (const [name, [x0, z0, x1, z1]] of Object.entries(ROOMS)) {
      const outdoor = name === 'patio';
      const floor = new THREE.Mesh(
        new THREE.PlaneGeometry(x1 - x0, z1 - z0),
        new THREE.MeshStandardMaterial({ color: outdoor ? 0x0f1e14 : 0x151b22, roughness: 0.95 }));
      floor.rotation.x = -Math.PI / 2;
      floor.position.copy(w((x0 + x1) / 2, (z0 + z1) / 2, 0));
      s.add(floor);
      const ol = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(x1 - x0, z1 - z0)),
        new THREE.LineBasicMaterial({ color: outdoor ? 0x2c5a3a : C.line }));
      ol.rotation.x = -Math.PI / 2; ol.position.copy(floor.position); ol.position.y = 0.005;
      s.add(ol);
      if (!outdoor) this.walls(x0, z0, x1, z1);
      else this.fence(x0, z0, x1, z1);

      const div = document.createElement('div');
      div.className = 'lbl room';
      div.innerHTML = `${ROOM_LABEL[name]} <b></b>`;
      const lbl = new CSS2DObject(div);
      lbl.position.copy(w(x0 + 0.3, z0 + 0.35, 0.02));
      lbl.center.set(0, 0);
      s.add(lbl);
      this.roomLabels[name] = div;
    }
    // puerta de paso interior (gaps visuales)
    this.hubSatellites();
  }

  walls(x0, z0, x1, z1) {
    const segs = [[x0, z0, x1, z0], [x1, z0, x1, z1], [x1, z1, x0, z1], [x0, z1, x0, z0]];
    for (const [ax, az, bx, bz] of segs) {
      const len = Math.hypot(bx - ax, bz - az);
      const g = new THREE.PlaneGeometry(len, H);
      const m = new THREE.Mesh(g, this.wallMat);
      m.position.copy(w((ax + bx) / 2, (az + bz) / 2, H / 2));
      m.rotation.y = ax === bx ? Math.PI / 2 : 0;
      this.scene.add(m);
      const e = new THREE.LineSegments(new THREE.EdgesGeometry(g), this.edgeMat);
      e.position.copy(m.position); e.rotation.copy(m.rotation);
      this.scene.add(e);
    }
  }

  fence(x0, z0, x1, z1) {
    const pts = [w(x0, z0, .6), w(x1, z0, .6), w(x1, z1, .6), w(x0, z1, .6)];
    const g = new THREE.BufferGeometry().setFromPoints([pts[0], pts[1], pts[1], w(x1, 3, .6), w(x1, 7, .6), pts[2], pts[2], pts[3]]);
    this.scene.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x2c5a3a })));
  }

  hubSatellites() {
    // servidor
    const hub = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.25, 0.4), new THREE.MeshStandardMaterial({ color: 0x0c1116, emissive: C.cyan, emissiveIntensity: 0.15 }));
    hub.position.copy(w(HUB[0], HUB[1], 0.8));
    this.scene.add(hub);
    this.hub = hub;
    this.label(hub, 'srv · N100 · pipeline', [0, 0.35, 0], 'hub');
    this.sats = {};
    for (const [area, [x, z]] of Object.entries(SAT)) {
      const g = new THREE.Group();
      const puck = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.18, 0.08, 20), new THREE.MeshStandardMaterial({ color: 0x0c1116, emissive: C.cyan, emissiveIntensity: 0.1 }));
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.2, 0.24, 32), new THREE.MeshBasicMaterial({ color: C.cyan, transparent: true, opacity: 0.0, side: THREE.DoubleSide }));
      ring.rotation.x = -Math.PI / 2; ring.position.y = 0.05;
      g.add(puck, ring);
      g.position.copy(w(x, z, 0.9));
      this.scene.add(g);
      this.sats[area] = { g, puck, ring };
    }
  }

  label(obj, text, off = [0, 0.3, 0], id) {
    const div = document.createElement('div');
    div.className = 'lbl';
    div.textContent = text;
    const l = new CSS2DObject(div);
    l.position.set(...off);
    obj.add(l);
    return div;
  }

  // ------------------------------------------------------------ dispositivos
  setDevices(devs) {
    for (const d of Object.values(devs)) this.updateDevice(d, true);
  }

  make(d) {
    const m = MOUNT[d.id];
    const g = new THREE.Group();
    g.userData.id = d.id;
    const parts = {};
    const pick = [];
    const std = (color, em = 0) => new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: em, roughness: .6 });

    if (d.tipo === 'luz') {
      const [x0, z0, x1, z1] = ROOMS[d.area];
      const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
      g.position.copy(w(cx, cz, d.area === 'patio' ? 2.8 : H - 0.15));
      parts.bulb = new THREE.Mesh(new THREE.SphereGeometry(0.14, 16, 12), new THREE.MeshBasicMaterial({ color: 0x333a40 }));
      parts.light = new THREE.PointLight(0xffd9a0, 0, d.area === 'patio' ? 12 : 8, 1.6);
      const glowTex = radialTexture();
      parts.glow = new THREE.Mesh(new THREE.PlaneGeometry(Math.min(x1 - x0, 6), Math.min(z1 - z0, 6)),
        new THREE.MeshBasicMaterial({ map: glowTex, color: 0xffc070, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
      parts.glow.rotation.x = -Math.PI / 2;
      parts.glow.position.y = -g.position.y + 0.02;
      parts.cone = new THREE.Mesh(new THREE.ConeGeometry(1.1, g.position.y, 24, 1, true),
        new THREE.MeshBasicMaterial({ color: 0xffd080, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
      parts.cone.position.y = -g.position.y / 2;
      g.add(parts.bulb, parts.light, parts.glow, parts.cone);
      pick.push(parts.bulb, parts.cone);
    }

    if (d.tipo === 'ventana' || d.tipo === 'persiana') {
      const W = 1.5, WH = 1.2, y0 = 0.9;
      g.position.copy(w(m.p[0], m.p[1], y0 + WH / 2));
      if (m.wall === 'z') g.rotation.y = Math.PI / 2;
      const frame = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(W, WH)), new THREE.LineBasicMaterial({ color: 0x8fb8c8 }));
      const glass = new THREE.Mesh(new THREE.PlaneGeometry(W, WH), new THREE.MeshBasicMaterial({ color: 0x5fb0d0, transparent: true, opacity: 0.12, side: THREE.DoubleSide }));
      g.add(frame, glass);
      pick.push(glass);
      if (d.tipo === 'ventana') {
        parts.sash = new THREE.Mesh(new THREE.BoxGeometry(W / 2, WH, 0.04), new THREE.MeshStandardMaterial({ color: 0x6fc6e0, transparent: true, opacity: 0.35 }));
        parts.sashEdge = new THREE.LineSegments(new THREE.EdgesGeometry(parts.sash.geometry), new THREE.LineBasicMaterial({ color: C.cyan }));
        parts.sash.add(parts.sashEdge);
        parts.sash.position.set(-W / 4, 0, 0.05);
        parts.W = W;
        // indicador de motor
        parts.motor = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.08, 0.08), std(0x222a31));
        parts.motor.position.set(-W / 2 + 0.15, WH / 2 + 0.06, 0.05);
        g.add(parts.sash, parts.motor);
        pick.push(parts.sash);
      } else {
        parts.box = new THREE.Mesh(new THREE.BoxGeometry(W + 0.1, 0.14, 0.14), std(0x2a333b));
        parts.box.position.set(0, WH / 2 + 0.07, 0.06);
        parts.slats = new THREE.Mesh(new THREE.PlaneGeometry(W, 1), new THREE.MeshStandardMaterial({ map: slatTexture(), color: 0xc0c8cf, side: THREE.DoubleSide }));
        parts.slats.position.z = 0.05;
        parts.WH = WH;
        g.add(parts.box, parts.slats);
        pick.push(parts.slats, parts.box);
      }
    }

    if (d.tipo === 'aire') {
      g.position.copy(w(m.p[0], m.p[1], 2.05));
      parts.body = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.28, 0.2), std(0xdfe6ea, 0));
      parts.led = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.03, 0.01), new THREE.MeshBasicMaterial({ color: 0x333333 }));
      parts.led.position.set(0.3, -0.06, 0.105 * m.dir);
      parts.dir = m.dir;
      const n = 60, pos = new Float32Array(n * 3);
      parts.pts = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: C.blue, size: 0.06, transparent: true, opacity: 0, depthWrite: false }));
      parts.pts.geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      parts.seed = Array.from({ length: n }, () => [Math.random(), (Math.random() - .5) * .8, Math.random()]);
      g.add(parts.body, parts.led, parts.pts);
      pick.push(parts.body);
    }

    if (d.tipo === 'ventilador') {
      if (m.wall) {
        g.position.copy(w(m.p[0], m.p[1], 2.0));
        g.rotation.y = Math.PI / 2;
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.03, 8, 24), std(0x9aa5ad));
        parts.rotor = new THREE.Group();
        for (let i = 0; i < 5; i++) {
          const b = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.16, 0.01), std(0xcfd6db));
          b.position.y = 0.08; const pv = new THREE.Group(); pv.rotation.z = i * Math.PI * 2 / 5; pv.add(b); parts.rotor.add(pv);
        }
        parts.axis = 'z';
        g.add(ring, parts.rotor); pick.push(ring);
      } else {
        g.position.copy(w(m.p[0], m.p[1], H - 0.3));
        const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.3), std(0x8a949b));
        rod.position.y = 0.15;
        parts.rotor = new THREE.Group();
        for (let i = 0; i < 4; i++) {
          const b = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.015, 0.14), std(0x9a7b5a));
          b.position.x = 0.5; const pv = new THREE.Group(); pv.rotation.y = i * Math.PI / 2; pv.add(b); parts.rotor.add(pv);
        }
        parts.hubm = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.08, 16), std(0x8a949b));
        parts.axis = 'y';
        g.add(rod, parts.rotor, parts.hubm); pick.push(parts.hubm, ...parts.rotor.children.map(c => c.children[0]));
      }
    }

    if (d.tipo === 'tele') {
      g.position.copy(w(m.p[0], m.p[1], 1.25));
      g.rotation.y = -Math.PI / 2 * -m.face;
      g.rotation.y = m.face < 0 ? -Math.PI / 2 : Math.PI / 2;
      parts.body = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.75, 0.05), std(0x0a0a0a));
      parts.tex = tvTexture();
      parts.screen = new THREE.Mesh(new THREE.PlaneGeometry(1.24, 0.69), new THREE.MeshBasicMaterial({ map: parts.tex.tex, color: 0x111111 }));
      parts.screen.position.z = 0.03;
      parts.light = new THREE.PointLight(0x6aa8ff, 0, 4, 2);
      parts.light.position.z = 0.6;
      g.add(parts.body, parts.screen, parts.light); pick.push(parts.body, parts.screen);
    }

    if (d.tipo === 'enchufe') {
      g.position.copy(w(m.p[0], m.p[1], 0.9));
      parts.body = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.3), std(0x2b3238));
      parts.led = new THREE.Mesh(new THREE.SphereGeometry(0.04, 8, 8), new THREE.MeshBasicMaterial({ color: 0x333333 }));
      parts.led.position.set(0, 0.2, 0);
      g.add(parts.body, parts.led); pick.push(parts.body);
    }

    if (d.tipo === 'cerradura') {
      g.position.copy(w(m.p[0], m.p[1], 1.05));
      parts.door = new THREE.Mesh(new THREE.BoxGeometry(1, 2.1, 0.06), new THREE.MeshStandardMaterial({ color: 0x4a3526, transparent: true, opacity: 0.85 }));
      parts.lock = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.16, 0.12), new THREE.MeshBasicMaterial({ color: C.green }));
      parts.lock.position.set(0.38, 0, 0);
      g.add(parts.door, parts.lock); pick.push(parts.door, parts.lock);
    }

    if (d.tipo === 'porton') {
      g.position.copy(w(m.p[0], m.p[1], 0.8));
      g.rotation.y = Math.PI / 2;
      const rail = new THREE.Mesh(new THREE.BoxGeometry(8, 0.04, 0.06), std(0x3a444c));
      rail.position.set(-2, -0.78, 0);
      parts.leaf = new THREE.Mesh(new THREE.BoxGeometry(4, 1.6, 0.06), new THREE.MeshStandardMaterial({ color: 0x3b4650, map: slatTexture(true) }));
      parts.edge = new THREE.LineSegments(new THREE.EdgesGeometry(parts.leaf.geometry), new THREE.LineBasicMaterial({ color: 0x8fb8c8 }));
      parts.leaf.add(parts.edge);
      g.add(rail, parts.leaf); pick.push(parts.leaf);
    }

    if (d.tipo === 'riego') {
      g.position.copy(w(m.p[0], m.p[1], 0));
      parts.heads = [[-2, -3], [2, -3], [0, 0], [-2, 3], [2, 3]].map(([dx, dz]) => {
        const h = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 0.15, 8), std(0x2f6f4a));
        h.position.set(dx, 0.08, dz); g.add(h); pick.push(h); return h;
      });
      const n = 300;
      parts.pts = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: 0x7fc8ff, size: 0.05, transparent: true, opacity: 0, depthWrite: false }));
      parts.pts.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
      parts.seed = Array.from({ length: n }, () => [Math.floor(Math.random() * 5), Math.random() * Math.PI * 2, Math.random(), 0.8 + Math.random() * 0.6]);
      g.add(parts.pts);
    }

    if (d.tipo === 'alarma') {
      g.position.copy(w(m.p[0], m.p[1], 2.2));
      parts.body = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.35, 0.35), std(0xdddddd));
      parts.lamp = new THREE.Mesh(new THREE.SphereGeometry(0.09, 12, 8), new THREE.MeshBasicMaterial({ color: 0x331111 }));
      parts.lamp.position.set(0.08, 0, 0);
      parts.light = new THREE.PointLight(C.red, 0, 25, 1.2);
      parts.light.position.set(-3, 2, 0);
      g.add(parts.body, parts.lamp, parts.light); pick.push(parts.body);
    }

    for (const p of pick) p.userData.id = d.id;
    this.scene.add(g);
    const lblOff = { luz: [0, 0.28, 0], ventana: [0, 0.8, 0], persiana: [0, 0.85, 0], aire: [0, 0.3, 0], ventilador: [0, 0.2, 0], tele: [0, 0.55, 0], enchufe: [0, 0.35, 0], cerradura: [0, 1.25, 0], porton: [-2, 1.1, 0], riego: [0, 0.5, 0], alarma: [0, 0.35, 0] }[d.tipo] || [0, .4, 0];
    const label = this.label(g, d.id, lblOff);
    return { g, parts, label, pick, flashT: 0 };
  }

  updateDevice(d, silent = false) {
    let e = this.dev[d.id];
    if (!e) e = this.dev[d.id] = this.make(d);
    e.state = { ...(e.state || {}), ...d };
    const s = e.state, p = e.parts;
    let txt = d.id;
    switch (s.tipo) {
      case 'luz': {
        const k = s.on ? s.brillo / 100 : 0;
        p.light.intensity = k * (s.area === 'patio' ? 9 : 6);
        p.glow.material.opacity = k * 0.55;
        p.cone.material.opacity = k * 0.05;
        p.bulb.material.color.set(s.on ? 0xffe0a0 : 0x333a40);
        txt += s.on ? ` ● ${s.brillo}%` : ' ○ off';
        break;
      }
      case 'ventana': case 'persiana': case 'porton':
        txt += ` ${s.pos}%` + (s.pos !== s.objetivo ? (s.objetivo > s.pos ? ' ▲' : ' ▼') : '');
        break;
      case 'aire': txt += s.on ? ` ❄ ${s.setpoint}°` : ' ○ off'; p.led.material.color.set(s.on ? C.green : 0x333333); break;
      case 'ventilador': case 'tele': case 'riego': txt += s.on ? ' ● on' : ' ○ off'; break;
      case 'enchufe': txt += s.on ? ` ● ${s.w} W` : ' ○ 0 W'; p.led.material.color.set(s.on ? C.green : 0x333333); break;
      case 'cerradura': txt += s.trabada ? ' 🔒 trabada' : ' 🔓 abierta'; p.lock.material.color.set(s.trabada ? C.green : C.red); break;
      case 'alarma': txt += s.disparada ? ' ⚠ DISPARADA' : s.armada ? ' ● armada' : ' ○ desarmada'; break;
    }
    e.label.textContent = txt;
    e.label.classList.toggle('off', s.on === false);
    if (!silent) this.flash(d.id);
  }

  motors(cambios) {
    for (const c of cambios) {
      const e = this.dev[c.id];
      if (e) this.updateDevice({ ...e.state, ...c }, true);
    }
  }

  flash(id, ms = 3500) {
    const e = this.dev[id];
    if (!e) return;
    e.label.classList.add('flash');
    clearTimeout(e._ft);
    e._ft = setTimeout(() => e.label.classList.remove('flash'), ms);
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.3, 0.34, 40), new THREE.MeshBasicMaterial({ color: C.cyan, transparent: true, side: THREE.DoubleSide, depthWrite: false }));
    ring.position.copy(e.g.getWorldPosition(new THREE.Vector3()));
    ring.lookAt(this.camera.position);
    this.scene.add(ring);
    this.anim.push({ t: 0, dur: 0.9, fn: (k) => { ring.scale.setScalar(1 + k * 3); ring.material.opacity = 1 - k; }, end: () => { this.scene.remove(ring); ring.geometry.dispose(); } });
  }

  // ------------------------------------------------------------ sensores / etiquetas de habitaciones
  setSensors(sen, satelite) {
    this.sensors = sen;
    for (const [a, div] of Object.entries(this.roomLabels)) {
      const s = sen[a]; if (!s) continue;
      const extra = [s.mov ? '<span style="color:#ffb454">◎mov</span>' : '', s.humo ? '<span style="color:#ff5c5c">humo</span>' : '', s.agua ? '<span style="color:#ff5c5c">agua</span>' : ''].join(' ');
      div.querySelector('b').innerHTML = `${(+s.temp).toFixed(1)}° ${Math.round(s.hum)}% ${extra}`;
      this.motion(a, s.mov);
      if (a === 'cocina') this.smoke(!!s.humo);
      if (s.agua !== undefined) this.leak(a, !!s.agua);
    }
    const lux = sen.exterior?.lux ?? 10000;
    const day = Math.min(1, lux / 6000);
    this.hemi.intensity = 0.15 + day * 0.55;
    this.sun.intensity = day * 0.9;
  }

  motion(area, on) {
    this._mot = this._mot || {};
    let m = this._mot[area];
    if (!m) {
      const [x0, z0, x1, z1] = ROOMS[area];
      m = new THREE.Mesh(new THREE.RingGeometry(0.1, 0.16, 32), new THREE.MeshBasicMaterial({ color: C.amber, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false }));
      m.rotation.x = -Math.PI / 2;
      m.position.copy(w((x0 + x1) / 2 + 0.7, (z0 + z1) / 2 + 0.7, 0.03));
      this.scene.add(m);
      this._mot[area] = m;
    }
    m.userData.on = on;
  }

  smoke(on) {
    if (!this._smoke) {
      const n = 160, g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
      this._smoke = new THREE.Points(g, new THREE.PointsMaterial({ color: 0x9aa0a6, size: 0.35, transparent: true, opacity: 0, depthWrite: false }));
      this._smoke.userData.seed = Array.from({ length: n }, () => [Math.random() * 3, Math.random() * 6, Math.random()]);
      this.scene.add(this._smoke);
    }
    this._smoke.userData.on = on;
  }

  leak(area, on) {
    this._leak = this._leak || {};
    let m = this._leak[area];
    if (!m) {
      const [x0, z0, x1, z1] = ROOMS[area];
      m = new THREE.Mesh(new THREE.CircleGeometry(1, 40), new THREE.MeshBasicMaterial({ color: 0x3a8cff, transparent: true, opacity: 0.0, depthWrite: false }));
      m.rotation.x = -Math.PI / 2;
      m.position.copy(w((x0 + x1) / 2 - 0.5, (z0 + z1) / 2, 0.02));
      this.scene.add(m);
      this._leak[area] = m;
    }
    m.userData.on = on;
  }

  setSatellite(area) {
    this.satelite = area;
    for (const [a, s] of Object.entries(this.sats)) s.puck.material.emissiveIntensity = a === area ? 0.9 : 0.08;
  }

  // ------------------------------------------------------------ efectos del pipeline
  wake(area = this.satelite) {
    const s = this.sats[area]; if (!s) return;
    for (let i = 0; i < 3; i++) {
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.25, 0.3, 48), new THREE.MeshBasicMaterial({ color: C.cyan, transparent: true, side: THREE.DoubleSide, depthWrite: false }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.copy(s.g.position);
      this.scene.add(ring);
      this.anim.push({ t: -i * 0.25, dur: 1.4, fn: k => { ring.scale.setScalar(1 + k * 9); ring.material.opacity = (1 - k) * 0.8; }, end: () => this.scene.remove(ring) });
    }
  }

  listening(on) {
    this._listening = on;
  }

  // paquete: satélite -> servidor -> dispositivos
  packet(ids, area = this.satelite) {
    const s = this.sats[area]; if (!s) return;
    const from = s.g.position.clone();
    const hub = this.hub.position.clone();
    this.arc(from, hub, C.cyan, 0.7, () => {
      this.hub.material.emissiveIntensity = 1;
      setTimeout(() => this.hub.material.emissiveIntensity = 0.15, 300);
      for (const id of ids) {
        const e = this.dev[id]; if (!e) continue;
        this.arc(hub, e.g.getWorldPosition(new THREE.Vector3()), C.green, 0.8, () => this.flash(id));
      }
    });
  }

  arc(a, b, color, dur, done) {
    const mid = a.clone().lerp(b, 0.5); mid.y += 2 + a.distanceTo(b) * 0.25;
    const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getPoints(40)), new THREE.LineDashedMaterial({ color, dashSize: 0.2, gapSize: 0.12, transparent: true }));
    line.computeLineDistances();
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 8), new THREE.MeshBasicMaterial({ color }));
    this.scene.add(line, dot);
    this.anim.push({ t: 0, dur, fn: k => { dot.position.copy(curve.getPoint(k)); }, end: () => { done?.(); this.anim.push({ t: 0, dur: 0.6, fn: k => line.material.opacity = 1 - k, end: () => { this.scene.remove(line, dot); line.geometry.dispose(); } }); } });
  }

  // ------------------------------------------------------------ interacción
  ndc(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }
  pickAt(e) {
    this.raycaster.setFromCamera(this.ndc(e), this.camera);
    const all = Object.values(this.dev).flatMap(d => d.pick);
    const hit = this.raycaster.intersectObjects(all, false)[0];
    return hit?.object.userData.id;
  }
  click(e) {
    if (!this._down || Math.hypot(e.clientX - this._down[0], e.clientY - this._down[1]) > 4) return;
    const id = this.pickAt(e);
    if (id) this.onClickDevice?.(this.dev[id].state);
  }
  hover(e) {
    const id = this.pickAt(e);
    this.renderer.domElement.style.cursor = id ? 'pointer' : 'grab';
    if (this._hover !== id) {
      if (this._hover && this.dev[this._hover]) this.dev[this._hover].label.classList.remove('flash');
      if (id) this.dev[id].label.classList.add('flash');
      this._hover = id;
    }
  }
  topView(on) {
    const t = this.controls.target;
    if (on) this.camera.position.set(t.x + 0.01, 22, t.z + 0.01);
    else this.camera.position.set(-3.5, 13.5, 14.5);
  }
  resize() {
    const { clientWidth: W, clientHeight: Hh } = this.el;
    if (!W || !Hh) return;
    this.renderer.setSize(W, Hh);
    this.css.setSize(W, Hh);
    this.camera.aspect = W / Hh;
    this.camera.updateProjectionMatrix();
  }

  // ------------------------------------------------------------ loop
  loop() {
    requestAnimationFrame(() => this.loop());
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const T = this.clock.elapsedTime;
    for (const e of Object.values(this.dev)) {
      const s = e.state, p = e.parts;
      if (s.tipo === 'ventana') {
        const k = (p.cur ??= s.pos) ; p.cur += (s.pos - p.cur) * Math.min(1, dt * 6);
        p.sash.position.x = -p.W / 4 + (p.cur / 100) * (p.W / 2);
        p.motor.material.emissive.set(s.pos !== s.objetivo ? C.amber : 0x000000); p.motor.material.emissiveIntensity = s.pos !== s.objetivo ? 0.8 + Math.sin(T * 20) * .2 : 0;
      } else if (s.tipo === 'persiana') {
        p.cur ??= s.pos; p.cur += (s.pos - p.cur) * Math.min(1, dt * 6);
        const closed = Math.max(0.02, 1 - p.cur / 100);
        p.slats.scale.y = p.WH * closed;
        p.slats.position.y = p.WH / 2 - (p.WH * closed) / 2;
      } else if (s.tipo === 'porton') {
        p.cur ??= s.pos; p.cur += (s.pos - p.cur) * Math.min(1, dt * 6);
        p.leaf.position.x = -(p.cur / 100) * 3.8 + 0;
        p.leaf.position.x = 2 - 2 - (p.cur / 100) * 3.8;
      } else if (s.tipo === 'ventilador') {
        p.spd = (p.spd || 0) + ((s.on ? 12 : 0) - (p.spd || 0)) * dt * 1.2;
        if (p.axis === 'y') p.rotor.rotation.y += p.spd * dt; else p.rotor.rotation.z += p.spd * dt * 2;
      } else if (s.tipo === 'aire') {
        const pos = p.pts.geometry.attributes.position.array;
        p.pts.material.opacity += ((s.on ? 0.8 : 0) - p.pts.material.opacity) * dt * 3;
        const room = this.sensors?.[s.area]?.temp ?? 22;
        p.pts.material.color.set(s.setpoint < room ? C.blue : C.amber);
        p.seed.forEach((sd, i) => {
          sd[0] = (sd[0] + dt * 0.5) % 1;
          pos[i * 3] = sd[1];
          pos[i * 3 + 1] = -0.15 - sd[0] * 1.3;
          pos[i * 3 + 2] = p.dir * (0.12 + sd[0] * 1.6 + Math.sin(T * 3 + i) * 0.05 * sd[0]);
        });
        p.pts.geometry.attributes.position.needsUpdate = true;
      } else if (s.tipo === 'tele') {
        p.screen.material.color.set(s.on ? 0xffffff : 0x111111);
        p.light.intensity = s.on ? 1.2 + Math.sin(T * 7) * 0.4 : 0;
        if (s.on && Math.floor(T * 8) !== p._f) { p._f = Math.floor(T * 8); p.tex.draw(T); }
      } else if (s.tipo === 'riego') {
        const pos = p.pts.geometry.attributes.position.array;
        p.pts.material.opacity += ((s.on ? 0.85 : 0) - p.pts.material.opacity) * dt * 3;
        p.seed.forEach((sd, i) => {
          sd[2] = (sd[2] + dt * 0.8) % 1;
          const h = p.heads[sd[0]].position, r = sd[2] * 1.6 * sd[3];
          const ang = sd[1] + T * 0.6;
          pos[i * 3] = h.x + Math.cos(ang) * r;
          pos[i * 3 + 1] = 0.15 + sd[2] * 1.4 * (1 - sd[2]) * 2.2;
          pos[i * 3 + 2] = h.z + Math.sin(ang) * r;
        });
        p.pts.geometry.attributes.position.needsUpdate = true;
      } else if (s.tipo === 'alarma') {
        const on = s.disparada;
        const k = on ? (Math.sin(T * 12) > 0 ? 1 : 0) : 0;
        p.lamp.material.color.set(on ? (k ? C.red : 0x440000) : (s.armada ? 0x113311 : 0x331111));
        p.light.intensity = k * 30;
        this.edgeMat.color.set(on && k ? C.red : C.cyan);
      }
    }
    // satélite escuchando
    const sat = this.sats[this.satelite];
    if (sat) {
      sat.ring.material.opacity = this._listening ? 0.5 + Math.sin(T * 10) * 0.4 : 0.15;
      sat.ring.scale.setScalar(this._listening ? 1.4 + Math.sin(T * 10) * 0.2 : 1);
    }
    if (this._mot) for (const m of Object.values(this._mot)) {
      if (m.userData.on) { const k = (T * 0.8) % 1; m.scale.setScalar(1 + k * 12); m.material.opacity = (1 - k) * 0.7; }
      else m.material.opacity = 0;
    }
    if (this._smoke) {
      const sm = this._smoke, pos = sm.geometry.attributes.position.array;
      sm.material.opacity += ((sm.userData.on ? 0.35 : 0) - sm.material.opacity) * dt * 2;
      if (sm.material.opacity > 0.01) sm.userData.seed.forEach((sd, i) => {
        sd[2] = (sd[2] + dt * 0.15) % 1;
        pos[i * 3] = OX + 9 + sd[0] + Math.sin(T + i) * 0.2;
        pos[i * 3 + 1] = 0.5 + sd[2] * 1.9;
        pos[i * 3 + 2] = OZ + 5 + sd[1] + Math.cos(T * 0.7 + i) * 0.2;
      });
      sm.geometry.attributes.position.needsUpdate = true;
    }
    if (this._leak) for (const m of Object.values(this._leak)) {
      m.material.opacity += ((m.userData.on ? 0.45 : 0) - m.material.opacity) * dt * 2;
      m.scale.setScalar(m.userData.on ? 1 + Math.sin(T * 2) * 0.05 : 0.5);
    }
    this.anim = this.anim.filter(a => {
      a.t += dt;
      if (a.t < 0) return true;
      const k = Math.min(1, a.t / a.dur);
      a.fn(k);
      if (k >= 1) { a.end?.(); return false; }
      return true;
    });
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.css.render(this.scene, this.camera);
  }
}

// ------------------------------------------------------------ texturas procedurales
function radialTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d'), gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.4, 'rgba(255,255,255,.35)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}
function slatTexture(vertical = false) {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#8a949c'; g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#5a646c';
  for (let i = 0; i < 64; i += 8) vertical ? g.fillRect(i, 0, 2, 64) : g.fillRect(0, i, 64, 2);
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(vertical ? 6 : 1, vertical ? 1 : 3);
  return t;
}
function tvTexture() {
  const c = document.createElement('canvas'); c.width = 128; c.height = 72;
  const g = c.getContext('2d');
  const tex = new THREE.CanvasTexture(c);
  return {
    tex, draw(T) {
      const hue = (T * 20) % 360;
      g.fillStyle = `hsl(${hue},50%,25%)`; g.fillRect(0, 0, 128, 72);
      for (let i = 0; i < 6; i++) { g.fillStyle = `hsla(${(hue + i * 50) % 360},70%,${40 + Math.random() * 30}%,.8)`; g.fillRect(Math.random() * 128, Math.random() * 72, 10 + Math.random() * 40, 6 + Math.random() * 20); }
      g.fillStyle = 'rgba(0,0,0,.25)'; for (let y = 0; y < 72; y += 3) g.fillRect(0, y, 128, 1);
      tex.needsUpdate = true;
    }
  };
}
