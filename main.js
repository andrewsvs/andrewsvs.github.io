// Suppress the harmless WebGL context error that appears under specific race conditions.
const originalConsoleError = console.error;
console.error = (...args) => {
    if (typeof args[0] === 'string' && args[0].includes('A WebGL context could not be created')) {
        return;
    }
    originalConsoleError.apply(console, args);
};

// Global debug flag – set to true to enable console logging
const DEBUG = false;
if (!DEBUG) {
    ['log', 'info', 'debug'].forEach(fn => {
        console[fn] = () => {};
    });
}

import * as THREE from 'three';
import * as GaussianSplats3D from '@mkkellogg/gaussian-splats-3d';

const viewerContainer = document.getElementById('viewer-container');
const customLoader = document.getElementById('custom-loader');
let viewer;
const threeScene = new THREE.Scene();
let currentAnnotations = [];
let hoveredAnnotation = null;
let constructionStages = [];
let isLoading = false;
let isPanLockActive = false;

// Dev toggle
let devOverlayVisible = false;

// Camera move tween variables
let camMoveActive = false;
let camMoveStart = 0;
let camMoveDuration = 1500; // ms
let camStartPos = new THREE.Vector3();
let camStartTarget = new THREE.Vector3();
let camTargetPos = new THREE.Vector3();
let camTargetTarget = new THREE.Vector3();

// Movable dot variables
let movableDot = null;
let dotPositionDisplay = null;
let isDraggingDot = false;
let dragPlane = new THREE.Plane();
let dragPoint = new THREE.Vector3();

// Zoom lock variables
let zoomLockEnabled = false;
let zoomMinDistance = 2; // Closest allowed distance
let zoomMaxDistance = 50; // Farthest allowed distance

// Expose helper to enable/disable zoom lock programmatically
window.setZoomLock = function(minDist, maxDist) {
    zoomLockEnabled = true;
    zoomMinDistance = minDist;
    zoomMaxDistance = maxDist;
    if (viewer && viewer.controls) {
        viewer.controls.minDistance = minDist;
        viewer.controls.maxDistance = maxDist;
    }
    console.log(`Zoom lock enabled: min ${minDist}, max ${maxDist}`);
};
window.clearZoomLock = function() {
    zoomLockEnabled = false;
    if (viewer && viewer.controls) {
        // Remove limits
        viewer.controls.minDistance = 0;
        viewer.controls.maxDistance = Infinity;
    }
    console.log('Zoom lock disabled');
};

// Annotations menu variables
let annotationsMenu = null;
let annotationsList = null;
let currentAnnotationsData = [];
let selectedAnnotationIndex = -1; // Track which annotation is selected


const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();



async function init() {
    viewerContainer.addEventListener('pointerdown', onAnnotationPointerDown, true); // annotation menu is still disabled inside handler
    viewerContainer.addEventListener('pointerup', () => { 
        if (viewer && viewer.controls) viewer.controls.enabled = true; 
        isDraggingDot = false;
    }, true);
    viewerContainer.addEventListener('pointermove', throttledOnAnnotationHover);
    
    // Add dot dragging events
    viewerContainer.addEventListener('pointerdown', onDotPointerDown, true);
    viewerContainer.addEventListener('pointermove', onDotPointerMove, true);

    try {
        const response = await fetch('./stages.json');
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        constructionStages = await response.json();
        createTimeline();
        
        // Initialize menu before loading stage
        initializeAnnotationsMenu();
        initializeCoordinatesToggle();
        
        loadStage(0);
    } catch (error) {
        console.error('Failed to load stages configuration:', error);
        alert('Failed to load construction stages. Please check the console for details.');
    }
}

        function throttle(func, limit) {
    let inThrottle;
    return function() {
        const args = arguments;
        const context = this;
        if (!inThrottle) {
            func.apply(context, args);
            inThrottle = true;
            setTimeout(() => inThrottle = false, limit);
        }
    }
}

const throttledOnAnnotationHover = throttle(onAnnotationHover, 16); // ~60fps

function moveCameraTo(positionVec, lookAtVec, duration = 1500) {
    if (!viewer || !viewer.camera || !viewer.controls) return;
    camMoveDuration = duration;
    camMoveStart = performance.now();
    camMoveActive = true;

    camStartPos.copy(viewer.camera.position);
    camStartTarget.copy(viewer.controls.target);
    camTargetPos.copy(positionVec);
    camTargetTarget.copy(lookAtVec);
}


async function loadStage(index) {
    if (isLoading) return;
    isLoading = true;
    customLoader.classList.remove('opacity-0', 'pointer-events-none');

    try {
        if (viewer) {
            try {
                viewer.dispose();
            } catch (e) {
                console.error("Error disposing viewer, continuing...", e);
            }
            const oldCanvas = viewerContainer.querySelector('canvas');
            if (oldCanvas) {
                viewerContainer.removeChild(oldCanvas);
            }
        }





        const stage = constructionStages[index];

        viewer = new GaussianSplats3D.Viewer({
            'rootElement': viewerContainer,
            'cameraUp': [0, -1, 0],
            'initialCameraPosition': stage.initialCameraPosition,
            'initialCameraLookAt': stage.initialCameraLookAt,
            'threeScene': threeScene,
            'sharedMemoryForWorkers': false,
            'workerUrl': './libs/gaussian-splats-3d.worker.js'
        });

        await viewer.addSplatScene(stage.splatUrl, {
            'showLoadingUI': false,
        });

        viewer.start();

        // Set pan lock status for the animation loop
        isPanLockActive = stage.panLock;

        // Apply rotation lock if specified for the stage
        if (stage.rotationLock) {
            viewer.controls.maxPolarAngle = Math.PI / 2;
        } else {
            viewer.controls.maxPolarAngle = Math.PI;
        }
        // Apply zoom lock settings (always)
        if (stage.minZoom !== undefined && stage.maxZoom !== undefined) {
            viewer.controls.minDistance = stage.minZoom;
            viewer.controls.maxDistance = stage.maxZoom;
        } else if (zoomLockEnabled) {
            viewer.controls.minDistance = zoomMinDistance;
            viewer.controls.maxDistance = zoomMaxDistance;
        }

        await addAnnotations(index);
        updateTimelineUI(index);

        // Initialize movable dot after stage is loaded
        createMovableDot();
        initializeDotControls();

        // Initialize annotations menu with a small delay to ensure DOM is ready
        // setTimeout(() => {
        //     initializeAnnotationsMenu();
        //     initializeCoordinatesToggle();
        // }, 100);

    } catch (error) {
        console.error(`Failed to load stage ${index}:`, error);
        alert(`Failed to load stage. See console for details.`);
    } finally {
        isLoading = false;
        customLoader.classList.add('opacity-0', 'pointer-events-none');
    }
}

        function createTimeline() {
    const desktopContainer = document.getElementById('timeline-container');
    const mobileContainer = document.getElementById('mobile-timeline-container');

    constructionStages.forEach((stage, index) => {
        // Create Desktop Item
        const desktopItem = document.createElement('div');
        desktopItem.className = 'timeline-item';
        desktopItem.innerHTML = `<div class="timeline-dot"></div><div class="timeline-label">${stage.title}</div>`;
        desktopItem.addEventListener('click', () => loadStage(index));
        // The 'mouseenter' event listener that was here has been permanently removed.
        // It was the root cause of the WebGL context errors.
        desktopContainer.appendChild(desktopItem);

        // Create Mobile Item
        const mobileItem = document.createElement('a');
        mobileItem.href = '#';
        mobileItem.className = 'block p-4 text-gray-700 hover:bg-gray-100';
        mobileItem.textContent = stage.title;
        mobileItem.addEventListener('click', (e) => {
            e.preventDefault();
            loadStage(index);
            toggleMenu(false); // Close menu on selection
        });
        mobileContainer.appendChild(mobileItem);
    });
}

async function addAnnotations(stageIndex) {
    // Clear previous annotations
    while(threeScene.children.length > 0){ 
        threeScene.remove(threeScene.children[0]); 
    }
    currentAnnotations = [];

    const stage = constructionStages[stageIndex];
    if (!stage.annotationsUrl) return;

    let stageAnnotations = [];
    try {
        const response = await fetch(stage.annotationsUrl);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        stageAnnotations = await response.json();
    } catch (error) {
        console.error(`Failed to load annotations from ${stage.annotationsUrl}:`, error);
        return; // Don't proceed if annotations fail to load
    }

    stageAnnotations.forEach(annoData => {
        // Outline (a thin ring)
        // Smaller ring for annotation outline
        const outlineGeometry = new THREE.RingGeometry(0.07, 0.08, 32);
        // Softer outline color (light slate)
        const outlineMaterial = new THREE.MeshBasicMaterial({ color: 0xbbbbbb, side: THREE.DoubleSide });
        const outline = new THREE.Mesh(outlineGeometry, outlineMaterial);

        // Fill (a circle that fits inside the ring)
        // Smaller fill circle
        const fillGeometry = new THREE.CircleGeometry(0.07, 32);
        // Subtle fill accent color (sky blue)
        const fillMaterial = new THREE.MeshBasicMaterial({ color: 0x3b82f6, transparent: true, opacity: 0.01, side: THREE.DoubleSide });
        const fill = new THREE.Mesh(fillGeometry, fillMaterial);
        fill.userData.isFill = true; // For easy identification

        const group = new THREE.Group();
        group.add(outline);
        group.add(fill);

        group.position.set(annoData.pos[0], annoData.pos[1], annoData.pos[2]);
        group.userData = {
            title: annoData.title,
            description: annoData.desc,
            targetScale: 1.0,
            targetOpacity: 0.01
        };

        threeScene.add(group);
        currentAnnotations.push(group);
    });
    
    // Populate the annotations menu
    populateAnnotationsMenu(stageAnnotations);
}

                                function onAnnotationHover(event) {
    const rect = viewerContainer.getBoundingClientRect();

    // Final fix: Check if the mouse is actually inside the viewer container.
    // This prevents hover logic from running when the cursor re-enters from another element,
    // which was the true root cause of the WebGL context errors.
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) {
        // If outside, but an annotation was previously hovered, un-hover it.
        if (hoveredAnnotation) {
            hoveredAnnotation.scale.set(1, 1, 1);
            const oldFill = hoveredAnnotation.children.find(c => c.userData.isFill);
            if(oldFill) oldFill.material.opacity = 0.01;
            hoveredAnnotation = null;
        }
        return;
    }

    if (!viewer || !viewer.camera) return;

    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    raycaster.setFromCamera(mouse, viewer.camera);

    const intersects = raycaster.intersectObjects(currentAnnotations, true);
    const intersectedGroup = (intersects.length > 0) ? intersects[0].object.parent : null;

    // Handle un-hovering
    if (hoveredAnnotation && hoveredAnnotation !== intersectedGroup) {
        hoveredAnnotation.userData.targetScale = 1.0;
        hoveredAnnotation.userData.targetOpacity = 0.01;
        hoveredAnnotation = null;
    }

    // Handle new hover
    if (intersectedGroup && hoveredAnnotation !== intersectedGroup) {
        hoveredAnnotation = intersectedGroup;
        hoveredAnnotation.userData.targetScale = 1.5;
        hoveredAnnotation.userData.targetOpacity = 0.8;
    }
}

        function onAnnotationPointerDown(event) {
    if (!viewer || !viewer.camera) return;
    
    console.log('Annotation pointer down event triggered');
    
    // If click happens within the construction stages mobile menu, allow it to propagate for its own handlers
    const stagesMenuEl = document.getElementById('mobile-menu');
    if (stagesMenuEl && stagesMenuEl.contains(event.target)) {
        // Let the menu handle the click (e.g., stage links)
        return;
    }

    // Immediately close construction stages menu if it's open
    const mobileMenu = document.getElementById('mobile-menu');
    if (mobileMenu && mobileMenu.classList.contains('show')) {
        console.log('Construction stages menu is already open, closing it immediately');
        mobileMenu.classList.remove('show');
    }
    
    // Check if click is in the button area (top-right corner)
    const rect = viewerContainer.getBoundingClientRect();
    const clickX = event.clientX - rect.left;
    const clickY = event.clientY - rect.top;
    
    // If click is in the top-right area where buttons are, don't process annotation click
    if (clickX > rect.width - 150 && clickY < 80) {
        console.log('Click in button area, ignoring annotation click');
        return;
    }
    
    // Check if this is a dot click
    if (movableDot && movableDot.visible) {
        const mouseX = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        const mouseY = -((event.clientY - rect.top) / rect.height) * 2 + 1;
        
        raycaster.setFromCamera(new THREE.Vector2(mouseX, mouseY), viewer.camera);
        const dotIntersects = raycaster.intersectObject(movableDot);
        
        if (dotIntersects.length > 0) {
            console.log('Dot click detected, ignoring annotation click');
            return; // This is a dot click, not an annotation click
        }
    }
    
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    raycaster.setFromCamera(mouse, viewer.camera);

    const intersects = raycaster.intersectObjects(currentAnnotations, true);

    if (intersects.length > 0) {
        console.log('Annotation intersection found:', intersects[0].object.parent.userData.title);
        
        const group = intersects[0].object.parent;
        if (group && group.userData.title) {
            if (viewer.controls) viewer.controls.enabled = false;
            
            // Find the index of the clicked annotation
            const index = currentAnnotations.indexOf(group);
            if (index !== -1) {
                
                console.log('Opening annotations menu for index:', index);
                
                // Open the annotations menu
                toggleAnnotationsMenu(true);
                
                // Highlight the specific annotation (no modal)
                highlightAnnotation(index, false);
                
                // Scroll to the specific annotation in the menu
                setTimeout(() => {
                    const annotationItems = annotationsList.querySelectorAll('.p-3.border.rounded-lg');
                    if (annotationItems[index]) {
                        const targetItem = annotationItems[index];
                        const container = annotationsList;
                        const targetScrollTop = targetItem.offsetTop - container.clientHeight / 2 + targetItem.clientHeight / 2;
                        container.scrollTo({ top: targetScrollTop, behavior: 'smooth' });
                    }
                }, 100);
            }
            
            // Stop event propagation to prevent menu from closing and burger menu from triggering
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            
            console.log('Event propagation stopped');
        }
    } else {
        console.log('No annotation intersection found');
    }
}

function showModal(title, description) {
    const modal = document.getElementById('annotation-modal');
    const modalContent = document.getElementById('modal-content');
    const modalDescription = document.getElementById('modal-description');

    modalContent.querySelector('h3').textContent = title;
    modalDescription.textContent = description;

    modal.classList.remove('opacity-0');
    modal.classList.remove('pointer-events-none');
    modal.classList.add('opacity-100');
    modal.classList.add('pointer-events-auto');

    const closeModalButton = document.getElementById('close-modal');
    closeModalButton.addEventListener('click', () => {
        modal.classList.remove('opacity-100');
        modal.classList.remove('pointer-events-auto');
        modal.classList.add('opacity-0');
        modal.classList.add('pointer-events-none');
    });
}

function updateTimelineUI(activeIndex) {
    const items = document.querySelectorAll('.timeline-item');
    items.forEach((item, index) => {
        item.classList.toggle('active', index === activeIndex);
    });
}

function updateCameraCoordinates() {
    if (viewer && viewer.camera) {
        const position = viewer.camera.position;
        const target = viewer.controls ? viewer.controls.target : new THREE.Vector3();
        
        const positionElement = document.getElementById('camera-position');
        const lookatElement = document.getElementById('camera-lookat');
        
        if (positionElement && lookatElement) {
            positionElement.textContent = `[${position.x.toFixed(2)}, ${position.y.toFixed(2)}, ${position.z.toFixed(2)}]`;
            lookatElement.textContent = `[${target.x.toFixed(2)}, ${target.y.toFixed(2)}, ${target.z.toFixed(2)}]`;
        }
    }
}

function createMovableDot() {
    // Remove existing dot if it exists
    if (movableDot) {
        threeScene.remove(movableDot);
    }
    
    // Create a red sphere for the movable dot
    const geometry = new THREE.SphereGeometry(0.1, 16, 16);
    const material = new THREE.MeshBasicMaterial({ color: 0xff0000 });
    movableDot = new THREE.Mesh(geometry, material);
    
    // Set initial position
    movableDot.position.set(0, 0, 0);
    // Respect dev visibility
    movableDot.visible = devOverlayVisible;
    
    // Add to scene
    threeScene.add(movableDot);
    
    // Initialize position display
    dotPositionDisplay = document.getElementById('dot-position-display');
    updateDotPositionDisplay();
}

function initializeDotControls() {
    const dotXInput = document.getElementById('dot-x');
    const dotYInput = document.getElementById('dot-y');
    const dotZInput = document.getElementById('dot-z');
    
    // Set up event listeners for coordinate inputs
    dotXInput.addEventListener('input', updateDotPosition);
    dotYInput.addEventListener('input', updateDotPosition);
    dotZInput.addEventListener('input', updateDotPosition);
}

function updateDotPosition() {
    if (!movableDot) return;
    
    const x = parseFloat(document.getElementById('dot-x').value) || 0;
    const y = parseFloat(document.getElementById('dot-y').value) || 0;
    const z = parseFloat(document.getElementById('dot-z').value) || 0;
    
    movableDot.position.set(x, y, z);
    updateDotPositionDisplay();
}

function updateDotPositionDisplay() {
    if (!movableDot || !dotPositionDisplay) return;
    
    const pos = movableDot.position;
    dotPositionDisplay.textContent = `[${pos.x.toFixed(2)}, ${pos.y.toFixed(2)}, ${pos.z.toFixed(2)}]`;
}

function onDotPointerDown(event) {
    if (!viewer || !viewer.camera || !movableDot) return;
    
    const rect = viewerContainer.getBoundingClientRect();
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    raycaster.setFromCamera(mouse, viewer.camera);
    const intersects = raycaster.intersectObject(movableDot);

    if (intersects.length > 0) {
        isDraggingDot = true;
        if (viewer.controls) viewer.controls.enabled = false;
        
        // Set up drag plane perpendicular to camera view
        const cameraDirection = new THREE.Vector3();
        viewer.camera.getWorldDirection(cameraDirection);
        dragPlane.setFromNormalAndCoplanarPoint(cameraDirection, movableDot.position);
        
        event.stopImmediatePropagation();
    }
}

function onDotPointerMove(event) {
    if (!isDraggingDot || !viewer || !viewer.camera || !movableDot) return;
    
    const rect = viewerContainer.getBoundingClientRect();
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    raycaster.setFromCamera(mouse, viewer.camera);
    
    // Find intersection with drag plane
    if (raycaster.ray.intersectPlane(dragPlane, dragPoint)) {
        movableDot.position.copy(dragPoint);
        updateDotPositionDisplay();
        updateDotInputs();
    }
}

function updateDotInputs() {
    if (!movableDot) return;
    
    const pos = movableDot.position;
    document.getElementById('dot-x').value = pos.x.toFixed(2);
    document.getElementById('dot-y').value = pos.y.toFixed(2);
    document.getElementById('dot-z').value = pos.z.toFixed(2);
}

function initializeAnnotationsMenu() {
    annotationsMenu = document.getElementById('annotations-menu');
    annotationsList = document.getElementById('annotations-list');
    
    if (!annotationsMenu || !annotationsList) {
        console.error('Annotations menu elements not found, retrying in 50ms');
        setTimeout(() => {
            initializeAnnotationsMenu();
        }, 50);
        return;
    }
    
    console.log('Initializing annotations menu');
    
    // Menu button event
    const menuButton = document.getElementById('annotations-menu-button');
    if (menuButton) {
        menuButton.addEventListener('click', () => {
            console.log('Annotations menu button clicked');
            toggleAnnotationsMenu(true);
        });
    }
    
    // Close button event
    const closeButton = document.getElementById('close-annotations-menu');
    if (closeButton) {
        closeButton.addEventListener('click', () => {
            console.log('Close annotations menu clicked');
            toggleAnnotationsMenu(false);
        });
    }
    
    // Close menu when clicking outside
    document.addEventListener('click', function(event) {
        console.log('Document click handler 1 (annotations) triggered');
        const menuButton = document.getElementById('annotations-menu-button');
        const viewerContainer = document.getElementById('viewer-container');
        
        // Don't close if clicking inside the viewer container (for annotations)
        if (viewerContainer && viewerContainer.contains(event.target)) {
            console.log('Click inside viewer container, not closing annotations menu');
            return;
        }
        
        if (!annotationsMenu.contains(event.target) && !menuButton.contains(event.target)) {
            console.log('Closing annotations menu from document click');
            toggleAnnotationsMenu(false);
        }
    }, true); // Use capture phase
    
    console.log('Annotations menu initialized');
}

function toggleAnnotationsMenu(show) {
    if (show) {
        annotationsMenu.classList.add('show');
        
        // If menu is empty but we have data, populate it
        if (annotationsList && (annotationsList.children.length === 0 || annotationsList.children.length === 1 && annotationsList.children[0].textContent.includes('No annotations'))) {
            if (currentAnnotationsData.length > 0) {
                console.log('Repopulating empty annotations menu');
                populateAnnotationsMenu(currentAnnotationsData);
            }
        }
    } else {
        annotationsMenu.classList.remove('show');
        
        // Clear highlighting when menu is closed
        currentAnnotations.forEach((annotation, i) => {
            annotation.userData.targetScale = 1.0;
            annotation.userData.targetOpacity = 0.01;
        });
        
        // Clear any highlighted menu items
        const highlightedItems = annotationsList.querySelectorAll('.bg-blue-100.border-blue-300');
        highlightedItems.forEach(item => {
            item.classList.remove('bg-blue-100', 'border-blue-300');
        });
        
        // Clear selection state
        selectedAnnotationIndex = -1;
    }
}

function populateAnnotationsMenu(annotations) {
    // Store the annotations data regardless of menu state
    currentAnnotationsData = annotations;
    
    if (!annotationsList) {
        console.log('Annotations list not ready yet, storing data for later');
        return;
    }
    
    console.log('Populating annotations menu with:', annotations);
    
    annotationsList.innerHTML = '';
    
    if (annotations.length === 0) {
        const noAnnotationsItem = document.createElement('div');
        noAnnotationsItem.className = 'p-3 text-gray-500 text-center';
        noAnnotationsItem.textContent = 'No annotations available for this stage';
        annotationsList.appendChild(noAnnotationsItem);
        return;
    }
    
    annotations.forEach((annotation, index) => {
        const annotationItem = document.createElement('div');
        annotationItem.className = 'p-3 border rounded-lg cursor-pointer hover:bg-gray-50 transition-colors';
        annotationItem.innerHTML = `
            <div class="font-semibold text-gray-800">${annotation.title}</div>
            <div class="text-sm text-gray-600 mt-1">${annotation.desc}</div>
        `;
        
        // Hover effects for menu items
        annotationItem.addEventListener('mouseenter', () => {
            // Highlight annotation on canvas with smooth transition
            if (currentAnnotations[index]) {
                const annotation = currentAnnotations[index];
                annotation.userData.targetScale = 1.5;
                annotation.userData.targetOpacity = 0.8;
            }
        });
        
        annotationItem.addEventListener('mouseleave', () => {
            // Only clear hover if this annotation is not selected
            if (index !== selectedAnnotationIndex) {
                if (currentAnnotations[index]) {
                    const annotation = currentAnnotations[index];
                    annotation.userData.targetScale = 1.0;
                    annotation.userData.targetOpacity = 0.01;
                }
            }
        });
        
        annotationItem.addEventListener('click', () => {
            console.log('Annotation clicked:', annotation.title);
            // Smooth highlight annotation without modal
            highlightAnnotation(index, false);
            // Camera move from menu click
            const data = annotations[index];
            if (data && data.cameraPos && data.cameraLookAt) {
                moveCameraTo(new THREE.Vector3(...data.cameraPos), new THREE.Vector3(...data.cameraLookAt));
            }
        });
        
        annotationsList.appendChild(annotationItem);
    });
    
    console.log('Annotations menu populated with', annotations.length, 'items');
}

function highlightAnnotation(index, showModal = false) {
    // Set the selected annotation index
    selectedAnnotationIndex = index;
    
    // Reset all annotations to normal with smooth transition
    currentAnnotations.forEach((annotation, i) => {
        annotation.userData.targetScale = 1.0;
        annotation.userData.targetOpacity = 0.01;
    });
    
    // Clear any previously highlighted menu items
    const highlightedItems = annotationsList.querySelectorAll('.bg-blue-100.border-blue-300');
    highlightedItems.forEach(item => {
        item.classList.remove('bg-blue-100', 'border-blue-300');
    });
    
    // Highlight the selected annotation with smooth transition
    if (currentAnnotations[index]) {
        const selectedAnnotation = currentAnnotations[index];
        selectedAnnotation.userData.targetScale = 2.0;
        selectedAnnotation.userData.targetOpacity = 1.0;
        
        // Highlight the corresponding menu item
        const annotationItems = annotationsList.querySelectorAll('.p-3.border.rounded-lg');
        if (annotationItems[index]) {
            annotationItems[index].classList.add('bg-blue-100', 'border-blue-300');
        }
        
        // Move camera if coordinates are present
        if (currentAnnotationsData[index]) {
            const data = currentAnnotationsData[index];
            if (data.cameraPos && data.cameraLookAt) {
                moveCameraTo(new THREE.Vector3(...data.cameraPos), new THREE.Vector3(...data.cameraLookAt));
            }
        }
        // Only show modal if explicitly requested (for canvas clicks)
        if (showModal && currentAnnotationsData[index]) {
            showModal(currentAnnotationsData[index].title, currentAnnotationsData[index].desc);
        }
    }
}

function initializeCoordinatesToggle() {
    const toggleButton = document.getElementById('toggle-coordinates');
    const coordinatesOverlay = document.getElementById('camera-coordinates');
    let isVisible = true;
    
    toggleButton.addEventListener('click', () => {
        if (isVisible) {
            coordinatesOverlay.style.display = 'none';
            toggleButton.textContent = 'Show';
        } else {
            coordinatesOverlay.style.display = 'block';
            toggleButton.textContent = 'Hide';
        }
        isVisible = !isVisible;
    });
}


        function animate() {
    requestAnimationFrame(animate);

    // Smooth camera move handling
    if (camMoveActive && viewer && viewer.camera && viewer.controls) {
        const now = performance.now();
        const t = Math.min(1, (now - camMoveStart) / camMoveDuration);
        const easedT = THREE.MathUtils.smoothstep(t, 0, 1);
        viewer.camera.position.lerpVectors(camStartPos, camTargetPos, easedT);
        viewer.controls.target.lerpVectors(camStartTarget, camTargetTarget, easedT);
        viewer.controls.update();
        if (t >= 1) {
            camMoveActive = false;
        }
    }

    // Definitive Pan Lock Logic
    if (isPanLockActive && viewer && viewer.controls && viewer.camera) {
        // In this project's coordinate system, the Y-axis is inverted.
        // "Ground" is at y=0. Going "under" the ground means y becomes positive.
        // Therefore, we must prevent the target's y-coordinate from exceeding 0.
        if (viewer.controls.target.y > 0) {
            // Calculate how far "under" the ground the target is.
            const deltaY = viewer.controls.target.y;

            // Nudge both the camera and the target "up" (in the negative-y direction) by that amount.
            viewer.camera.position.y -= deltaY;
            viewer.controls.target.y -= deltaY; // This effectively clamps the target to 0
        }
    }

    // Update camera coordinates display
    updateCameraCoordinates();

    if (viewer && viewer.camera) {
        currentAnnotations.forEach((annotation, index) => {
            // Make annotations always face the camera
            annotation.quaternion.copy(viewer.camera.quaternion);

            // Animate scale for all annotations (including selected ones)
            const currentScale = annotation.scale.x;
            const targetScale = annotation.userData.targetScale || 1.0;
            if (Math.abs(currentScale - targetScale) > 0.001) {
                const newScale = THREE.MathUtils.lerp(currentScale, targetScale, 0.1);
                annotation.scale.set(newScale, newScale, newScale);
            }

            // Animate fill opacity for all annotations
            const fill = annotation.children.find(c => c.userData.isFill);
            if (fill) {
                const currentOpacity = fill.material.opacity;
                const targetOpacity = annotation.userData.targetOpacity || 0.01;
                if (Math.abs(currentOpacity - targetOpacity) > 0.001) {
                    const newOpacity = THREE.MathUtils.lerp(currentOpacity, targetOpacity, 0.1);
                    fill.material.opacity = newOpacity;
                }
            }
        });
    }
}

        function toggleMenu(show) {
    console.log('Toggle menu called with show:', show, 'Stack trace:', new Error().stack);
    const menu = document.getElementById('mobile-menu');
    if (show) {
        menu.classList.add('show');
        console.log('Opening construction stages menu');
    } else {
        menu.classList.remove('show');
        console.log('Closing construction stages menu');
    }
}

// Ensure menu starts hidden on page load
document.addEventListener('DOMContentLoaded', () => {
    const mobileMenu = document.getElementById('mobile-menu');
    const annotationsMenu = document.getElementById('annotations-menu');
    
    if (mobileMenu) {
        mobileMenu.classList.remove('show');
        mobileMenu.style.transform = 'translateX(100%)';
        console.log('Ensuring construction stages menu starts hidden');
    }
    
    if (annotationsMenu) {
        annotationsMenu.classList.remove('show');
        annotationsMenu.style.transform = 'translateX(100%)';
        console.log('Ensuring annotations menu starts hidden');
    }
});

document.getElementById('menu-button').addEventListener('click', () => {
    console.log('Burger menu button clicked');
    toggleMenu(true);
});

// Add close button handler for stages menu
document.addEventListener('DOMContentLoaded', () => {
    const closeStagesMenu = document.getElementById('close-stages-menu');
    if (closeStagesMenu) {
        closeStagesMenu.addEventListener('click', () => toggleMenu(false));
    }
});

// Optional: Close menu when clicking outside
document.addEventListener('click', function(event) {
    console.log('Document click handler 2 (construction stages) triggered');
    const menu = document.getElementById('mobile-menu');
    const menuButton = document.getElementById('menu-button');
    const closeButton = document.getElementById('close-stages-menu');
    const viewerContainer = document.getElementById('viewer-container');
    
    // Don't close if clicking inside the viewer container (for annotations)
    if (viewerContainer && viewerContainer.contains(event.target)) {
        console.log('Click inside viewer container, not closing construction stages menu');
        return;
    }
    
    if (!menu.contains(event.target) && !menuButton.contains(event.target) && !closeButton.contains(event.target)) {
        console.log('Closing construction stages menu from document click');
        toggleMenu(false);
    }
}, true); // Use capture phase

        const fullscreenButton = document.getElementById('fullscreen-button');
const enterFullscreenIcon = document.getElementById('enter-fullscreen-icon');
const exitFullscreenIcon = document.getElementById('exit-fullscreen-icon');

fullscreenButton.addEventListener('click', () => {
                const viewerElement = document.getElementById('fullscreen-wrapper');
    if (!document.fullscreenElement) {
        viewerElement.requestFullscreen().catch(err => {
            alert(`Error attempting to enable full-screen mode: ${err.message} (${err.name})`);
        });
    } else {
        document.exitFullscreen();
    }
});

document.addEventListener('fullscreenchange', () => {
    if (document.fullscreenElement) {
        enterFullscreenIcon.classList.add('hidden');
        exitFullscreenIcon.classList.remove('hidden');
    } else {
        enterFullscreenIcon.classList.remove('hidden');
        exitFullscreenIcon.classList.add('hidden');
    }
});

                const helpButton = document.getElementById('help-button');
const helpModal = document.getElementById('help-modal');
const closeHelpModal = document.getElementById('close-help-modal');
const helpModalContent = helpModal.querySelector('.transform');
const mouseGuideBtn = document.getElementById('mouse-guide-btn');
const touchGuideBtn = document.getElementById('touch-guide-btn');
const mouseInstructions = document.getElementById('mouse-instructions');
const touchInstructions = document.getElementById('touch-instructions');

helpButton.addEventListener('click', () => {
    helpModal.classList.remove('opacity-0', 'pointer-events-none');
    helpModalContent.classList.remove('scale-95');
    // Auto-detect touch support on open
    if ('ontouchstart' in window || navigator.maxTouchPoints > 0) {
        touchGuideBtn.click();
    } else {
        mouseGuideBtn.click();
    }
});

function closeHelp() {
    helpModalContent.classList.add('scale-95');
    helpModal.classList.add('opacity-0');
    setTimeout(() => {
        helpModal.classList.add('pointer-events-none');
    }, 300); // Wait for transition to finish
}

closeHelpModal.addEventListener('click', closeHelp);

mouseGuideBtn.addEventListener('click', () => {
    mouseInstructions.classList.remove('hidden');
    touchInstructions.classList.add('hidden');
    mouseGuideBtn.classList.add('bg-blue-500', 'text-white');
    mouseGuideBtn.classList.remove('text-gray-600');
    touchGuideBtn.classList.remove('bg-blue-500', 'text-white');
    touchGuideBtn.classList.add('text-gray-600');
});

touchGuideBtn.addEventListener('click', () => {
    touchInstructions.classList.remove('hidden');
    mouseInstructions.classList.add('hidden');
    touchGuideBtn.classList.add('bg-blue-500', 'text-white');
    touchGuideBtn.classList.remove('text-gray-600');
    mouseGuideBtn.classList.remove('bg-blue-500', 'text-white');
    mouseGuideBtn.classList.add('text-gray-600');
});

function initializeThemeSwitch() {
    const button = document.getElementById('theme-button');
    const menu = document.getElementById('theme-menu');
    if (!button || !menu) return;

    const options = menu.querySelectorAll('.theme-option');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)');

    function applyTheme(mode) {
        if (mode === 'auto') {
            document.body.classList.toggle('dark-mode', prefersDark.matches);
        } else if (mode === 'dark') {
            document.body.classList.add('dark-mode');
        } else {
            document.body.classList.remove('dark-mode');
        }
    }

    // Load saved pref
    let currentMode = localStorage.getItem('theme-mode') || 'auto';
    applyTheme(currentMode);

    // Toggle menu visibility
    button.addEventListener('click', (e) => {
        e.stopPropagation();
        menu.classList.toggle('hidden');
    });

    // Click outside closes
    document.addEventListener('click', () => {
        menu.classList.add('hidden');
    });

    // Handle option clicks
    options.forEach(opt => {
        opt.addEventListener('click', (e) => {
            e.stopPropagation();
            currentMode = opt.dataset.mode;
            localStorage.setItem('theme-mode', currentMode);
            applyTheme(currentMode);
            menu.classList.add('hidden');
        });
    });

    // React to system change when auto
    prefersDark.addEventListener('change', () => {
        if (currentMode === 'auto') applyTheme('auto');
    });
}


// Dev button toggle for movable dot and camera coordinates
const devButton = document.getElementById('dev-button');
const cameraOverlay = document.getElementById('camera-coordinates');
const movableControls = document.getElementById('movable-dot-controls');
if (devButton && cameraOverlay) {
    cameraOverlay.style.display = 'none';
    if (movableControls) movableControls.style.display = 'none';
    devButton.addEventListener('click', () => {
        devOverlayVisible = !devOverlayVisible;
        if (movableDot) movableDot.visible = devOverlayVisible;
        cameraOverlay.style.display = devOverlayVisible ? 'block' : 'none';
        if (movableControls) movableControls.style.display = devOverlayVisible ? 'block' : 'none';
    });
}

initializeThemeSwitch();
init();
animate();
