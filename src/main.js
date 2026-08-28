import * as THREE from 'three';
import { ARButton } from 'three/addons/webxr/ARButton.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

let camera, scene, renderer;
let reticle;
let hitTestSource = null;
let hitTestSourceRequested = false;
let thumbnailRenderer, thumbnailScene, thumbnailCamera;
let activeCategory = null;

let isDragging = false;
let dragStartTouch = null;

const raycaster = new THREE.Raycaster();

const placedObjects = []; // all furniture roots placed in the scene
let selectedObject = null;

const gltfLoader = new GLTFLoader();


const furnitureCatalog = [
  // Seating
  { id: 'chair', name: 'Chair', category: 'Seating', file: 'assets/models/chair.glb', targetHeight: 0.9 },
  { id: 'chairModernCushion', name: 'Modern Chair', category: 'Seating', file: 'assets/models/chairModernCushion.glb', targetHeight: 0.85 },
  { id: 'loungeChair', name: 'Lounge Chair', category: 'Seating', file: 'assets/models/loungeChair.glb', targetHeight: 0.8 },
  { id: 'loungeSofa', name: 'Sofa', category: 'Seating', file: 'assets/models/loungeSofa.glb', targetHeight: 0.8 },
  { id: 'stoolBar', name: 'Bar Stool', category: 'Seating', file: 'assets/models/stoolBar.glb', targetHeight: 0.75 },

  // Tables
  { id: 'table', name: 'Table', category: 'Tables', file: 'assets/models/table.glb', targetHeight: 0.5 },
  { id: 'tableCoffee', name: 'Coffee Table', category: 'Tables', file: 'assets/models/tableCoffee.glb', targetHeight: 0.4 },
  { id: 'tableCross', name: 'Cross Table', category: 'Tables', file: 'assets/models/tableCross.glb', targetHeight: 0.45 },
  { id: 'desk', name: 'Desk', category: 'Tables', file: 'assets/models/desk.glb', targetHeight: 0.75 },

  // Decor
  { id: 'bookcaseClosedWide', name: 'Bookcase', category: 'Decor', file: 'assets/models/bookcaseClosedWide.glb', targetHeight: 1.2 },
  { id: 'lampRoundFloor', name: 'Floor Lamp', category: 'Decor', file: 'assets/models/lampRoundFloor.glb', targetHeight: 1.4 },
  { id: 'pottedPlant', name: 'Potted Plant', category: 'Decor', file: 'assets/models/pottedPlant.glb', targetHeight: 0.6 },
  { id: 'rugRound', name: 'Round Rug', category: 'Decor', file: 'assets/models/rugRound.glb', targetHeight: 0.02 },
];

const categories = [...new Set(furnitureCatalog.map(item => item.category))];

let activeFurniture = null; // { scene, baseScale } for the currently selected catalog item
const modelCache = {}; // id -> loaded THREE.Group, so we don't reload from disk each time

function loadFurniture(item) {
  if (modelCache[item.id]) {
    activeFurniture = modelCache[item.id];
    console.log('Using cached model:', item.id, 'activeFurniture set to:', activeFurniture);
    return;
  }

    gltfLoader.load(item.file, (gltf) => {
    const model = gltf.scene;

    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const scaleFactor = item.targetHeight / size.y;

    const entry = { scene: model, baseScale: scaleFactor };
    modelCache[item.id] = entry;
    activeFurniture = entry;

    item.thumbnail = generateThumbnail(model);
    if (activeCategory === item.category) {
      renderFurnitureScroll(activeCategory); // refresh so the image actually shows
    }

    console.log('Loaded and cached:', item.id, 'scale:', scaleFactor);
  }, undefined, (error) => {
    console.error('Failed to load', item.id, error);
  });
}

init();

function init() {
  const canvas = document.getElementById('xr-canvas');

  scene = new THREE.Scene();

    initThumbnailRenderer();

  camera = new THREE.PerspectiveCamera(
    70,
    window.innerWidth / window.innerHeight,
    0.01,
    20
  );

  const light = new THREE.HemisphereLight(0xffffff, 0x444444, 1.5);
  light.position.set(0.5, 1, 0.25);
  scene.add(light);

    createReticle();

  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true; // Critical: enables WebXR rendering

    document.body.appendChild(
    ARButton.createButton(renderer, {
      requiredFeatures: ['hit-test'],
      optionalFeatures: ['dom-overlay'],
      domOverlay: { root: document.getElementById('ui-overlay') }
    })
  );

  window.addEventListener('resize', onWindowResize);

  renderer.setAnimationLoop(render);


    const overlay = document.getElementById('ui-overlay');
    overlay.addEventListener('touchstart', onTouchStart, { passive: false });
  overlay.addEventListener('touchmove', onTouchMove, { passive: false });
  overlay.addEventListener('touchend', onTouchEnd, { passive: false });

      furnitureCatalog.forEach(item => loadFurniture(item)); // preload all models + generate thumbnails
  activeFurniture = modelCache['chair']; // set default active item explicitly
      buildFurnitureUI();
        setupObjectControls();
}

function createReticle() {
  const geometry = new THREE.RingGeometry(0.08, 0.1, 32).rotateX(-Math.PI / 2);
  const material = new THREE.MeshBasicMaterial({ color: 0xffffff });
  reticle = new THREE.Mesh(geometry, material);
  reticle.matrixAutoUpdate = false; // we'll manually set its position/rotation from hit-test results
  reticle.visible = false;
  scene.add(reticle);
}




function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function render(timestamp, frame) {
  if (frame) {
    const referenceSpace = renderer.xr.getReferenceSpace();
    const session = renderer.xr.getSession();

    if (!hitTestSourceRequested) {
      session.requestReferenceSpace('viewer').then((viewerSpace) => {
        session.requestHitTestSource({ space: viewerSpace }).then((source) => {
          hitTestSource = source;
        });
      });

      session.addEventListener('end', () => {
        hitTestSourceRequested = false;
        hitTestSource = null;
      });

      hitTestSourceRequested = true;
    }

    if (hitTestSource) {
      const hitTestResults = frame.getHitTestResults(hitTestSource);

      if (hitTestResults.length > 0) {
        const hit = hitTestResults[0];
        const pose = hit.getPose(referenceSpace);

        reticle.visible = true;
        reticle.matrix.fromArray(pose.transform.matrix);
      } else {
        reticle.visible = false;
      }
    }

  }

  renderer.render(scene, camera);
}

function buildFurnitureUI() {
  const tabsContainer = document.getElementById('category-tabs');

  categories.forEach((cat, i) => {
    const tab = document.createElement('button');
    tab.className = 'category-tab';
    tab.textContent = cat;
    if (i === 0) tab.classList.add('active');

    tab.addEventListener('click', () => {
      document.querySelectorAll('.category-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      activeCategory = cat;
      renderFurnitureScroll(cat);
    });

    tabsContainer.appendChild(tab);
  });

  activeCategory = categories[0];
  renderFurnitureScroll(activeCategory);
}

function renderFurnitureScroll(category) {
  const scroll = document.getElementById('furniture-scroll');
  scroll.innerHTML = '';

  const items = furnitureCatalog.filter(item => item.category === category);

  items.forEach((item, index) => {
    const btn = document.createElement('button');
    btn.className = 'furniture-item';
    if (index === 0) btn.classList.add('active');

    const img = document.createElement('img');
    img.src = item.thumbnail || ''; // filled in once loaded/generated
    img.alt = item.name;

    const label = document.createElement('span');
    label.textContent = item.name;

    btn.appendChild(img);
    btn.appendChild(label);

    btn.addEventListener('click', () => {
      document.querySelectorAll('.furniture-item').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      loadFurniture(item);
    });

    scroll.appendChild(btn);
  });
}

function setSelected(object) {
  if (selectedObject) {
    selectedObject.traverse((child) => {
      if (child.isMesh) child.material.emissive?.setHex(0x000000);
    });
  }

  selectedObject = object;

  const controls = document.getElementById('object-controls');
  const slider = document.getElementById('rotate-slider');

  if (selectedObject) {
    selectedObject.traverse((child) => {
      if (child.isMesh && child.material.emissive) {
        child.material.emissive.setHex(0x2194ce);
        child.material.emissiveIntensity = 0.4;
      }
    });

    controls.classList.remove('hidden');
    slider.value = THREE.MathUtils.radToDeg(selectedObject.rotation.y) % 360;
  } else {
    controls.classList.add('hidden');
  }
}

let touchStartPos = null;
let touchMoved = false;
const DRAG_THRESHOLD = 10; // pixels

function screenToNDC(touch) {
  return {
    x: (touch.clientX / window.innerWidth) * 2 - 1,
    y: -(touch.clientY / window.innerHeight) * 2 + 1,
  };
}

function onTouchStart(event) {
if (event.target.closest('.furniture-item') || event.target.closest('.category-tab') || event.target.closest('#object-controls') || event.target.closest('#clear-scene-btn')) return;
  if (event.touches.length !== 1) return;

  event.preventDefault();

  const touch = event.touches[0];
  touchStartPos = { x: touch.clientX, y: touch.clientY };
  touchMoved = false;

  if (selectedObject) {
    const ndc = screenToNDC(touch);
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObject(selectedObject, true);
    isDragging = hits.length > 0;
    console.log('touchstart - hit selected object:', hits.length > 0);
  }
}

function onTouchMove(event) {
if (event.target.closest('.furniture-item') || event.target.closest('.category-tab') || event.target.closest('#object-controls') || event.target.closest('#clear-scene-btn')) return;
  if (event.touches.length !== 1 || !touchStartPos) return;

  event.preventDefault();

  const touch = event.touches[0];
  const dx = touch.clientX - touchStartPos.x;
  const dy = touch.clientY - touchStartPos.y;
  if (Math.hypot(dx, dy) > DRAG_THRESHOLD) touchMoved = true;

  console.log('touchmove. isDragging:', isDragging, 'touchMoved:', touchMoved);

  if (isDragging && selectedObject) {
    const ndc = screenToNDC(touch);
    raycaster.setFromCamera(ndc, camera);

    const planeY = selectedObject.position.y;
    const ray = raycaster.ray;
    const t = (planeY - ray.origin.y) / ray.direction.y;
    const point = ray.origin.clone().add(ray.direction.clone().multiplyScalar(t));

    selectedObject.position.x = point.x;
    selectedObject.position.z = point.z;
  }
}

function onTouchEnd(event) {
if (event.target.closest('.furniture-item') || event.target.closest('.category-tab') || event.target.closest('#object-controls') || event.target.closest('#clear-scene-btn')) {
      isDragging = false;
      return;
    }

  console.log('touchend. touchMoved:', touchMoved);

  if (!touchMoved) {
    const touch = event.changedTouches[0];
    const ndc = screenToNDC(touch);
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(placedObjects, true);

    console.log('touchend tap-check. placedObjects.length:', placedObjects.length, 'hits:', hits.length);

        if (hits.length > 0) {
      let root = hits[0].object;
      while (root.parent && !placedObjects.includes(root)) root = root.parent;
      setSelected(root);
      console.log('Selected existing object');
    } else {
      if (selectedObject) {
        // Just deselect — don't place anything on this tap
        setSelected(null);
      } else if (reticle.visible && activeFurniture) {
        console.log('No hit on furniture — placing NEW object. reticle.visible:', reticle.visible);
        const model = activeFurniture.scene.clone();
        model.traverse((child) => { if (child.isMesh) child.material = child.material.clone(); });
        model.position.setFromMatrixPosition(reticle.matrix);
        model.quaternion.setFromRotationMatrix(reticle.matrix);
        const s = activeFurniture.baseScale;
        model.scale.set(s, s, s);

        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const hitGeo = new THREE.BoxGeometry(size.x * 1.3, size.y * 1.3, size.z * 1.3);
        const hitMat = new THREE.MeshBasicMaterial({ visible: false });
        const hitBox = new THREE.Mesh(hitGeo, hitMat);
        hitBox.position.copy(model.worldToLocal(center.clone()));
        model.add(hitBox);

        scene.add(model);
        placedObjects.push(model);
      }
    }
  }

  isDragging = false;
  touchStartPos = null;
}


function initThumbnailRenderer() {
  thumbnailRenderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
  thumbnailRenderer.setSize(128, 128);

  thumbnailScene = new THREE.Scene();

  thumbnailCamera = new THREE.PerspectiveCamera(45, 1, 0.01, 10);

  const light1 = new THREE.HemisphereLight(0xffffff, 0x444444, 2);
  thumbnailScene.add(light1);
  const light2 = new THREE.DirectionalLight(0xffffff, 1.5);
  light2.position.set(1, 1, 1);
  thumbnailScene.add(light2);
}

function generateThumbnail(modelScene) {
  const clone = modelScene.clone();
  clone.traverse((child) => {
    if (child.isMesh) child.material = child.material.clone();
  });

  // Center and frame the model
  const box = new THREE.Box3().setFromObject(clone);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  clone.position.sub(center);

  const maxDim = Math.max(size.x, size.y, size.z);
  const distance = maxDim * 2.2;

  thumbnailScene.add(clone);
  thumbnailCamera.position.set(distance, distance * 0.8, distance);
  thumbnailCamera.lookAt(0, 0, 0);

  thumbnailRenderer.render(thumbnailScene, thumbnailCamera);
  const dataUrl = thumbnailRenderer.domElement.toDataURL('image/png');

  thumbnailScene.remove(clone);

  return dataUrl;
}

function setupObjectControls() {
  const slider = document.getElementById('rotate-slider');
  const deleteBtn = document.getElementById('delete-btn');
  const clearBtn = document.getElementById('clear-scene-btn');

  slider.addEventListener('input', () => {
    if (!selectedObject) return;
    const degrees = parseFloat(slider.value);
    selectedObject.rotation.y = THREE.MathUtils.degToRad(degrees);
  });

  deleteBtn.addEventListener('click', () => {
    if (!selectedObject) return;
    scene.remove(selectedObject);
    const idx = placedObjects.indexOf(selectedObject);
    if (idx !== -1) placedObjects.splice(idx, 1);
    setSelected(null);
  });

  clearBtn.addEventListener('click', () => {
    placedObjects.forEach(obj => scene.remove(obj));
    placedObjects.length = 0; // empty the array in place
    setSelected(null);
  });
}