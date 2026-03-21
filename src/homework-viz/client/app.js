import * as pdfjsLib from 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs';

const state = {
  file: null,
  pdfDoc: null,
  currentPage: 1,
  totalPages: 0,
};

const elements = {
  pdfFile: document.getElementById('pdf-file'),
  dropZone: document.getElementById('drop-zone'),
  dropLabel: document.getElementById('drop-label'),
  titleInput: document.getElementById('title-input'),
  sectionType: document.getElementById('section-type'),
  customTypeField: document.getElementById('custom-type-field'),
  customTypeInput: document.getElementById('custom-type-input'),
  pageOffset: document.getElementById('page-offset'),
  tocPage: document.getElementById('toc-page'),
  ingestButton: document.getElementById('ingest-button'),
  ingestStatus: document.getElementById('ingest-status'),
  jumpFirst: document.getElementById('jump-first'),
  jumpLast: document.getElementById('jump-last'),
  useCurrentPage: document.getElementById('use-current-page'),
  prevPage: document.getElementById('prev-page'),
  nextPage: document.getElementById('next-page'),
  currentPageLabel: document.getElementById('current-page-label'),
  logicalPageLabel: document.getElementById('logical-page-label'),
  tocPageLabel: document.getElementById('toc-page-label'),
  totalPagesLabel: document.getElementById('total-pages-label'),
  viewerTitle: document.getElementById('viewer-title'),
  viewerPlaceholder: document.getElementById('viewer-placeholder'),
  canvas: document.getElementById('pdf-canvas'),
  refreshDocuments: document.getElementById('refresh-documents'),
  documentsList: document.getElementById('documents-list'),
  documentCardTemplate: document.getElementById('document-card-template'),
};

function setStatus(message, isError = false) {
  elements.ingestStatus.textContent = message;
  elements.ingestStatus.dataset.state = isError ? 'error' : 'ok';
}

function getSectionTypeValue() {
  if (elements.sectionType.value !== 'custom') return elements.sectionType.value;
  const custom = elements.customTypeInput.value.trim();
  return custom || 'paragraphs';
}

function updateTypeVisibility() {
  const custom = elements.sectionType.value === 'custom';
  elements.customTypeField.classList.toggle('hidden', !custom);
}

function updatePageMeta() {
  const offset = Number(elements.pageOffset.value || 0);
  const tocPage = Number(elements.tocPage.value || 1);
  elements.currentPageLabel.textContent = state.pdfDoc ? String(state.currentPage) : '-';
  elements.logicalPageLabel.textContent = state.pdfDoc ? String(state.currentPage + offset) : '-';
  elements.tocPageLabel.textContent = state.pdfDoc ? `${tocPage} / ${tocPage + offset}` : '-';
  elements.totalPagesLabel.textContent = state.pdfDoc ? String(state.totalPages) : '-';
}

async function renderCurrentPage() {
  if (!state.pdfDoc) return;

  const page = await state.pdfDoc.getPage(state.currentPage);
  const viewport = page.getViewport({ scale: 1.35 });
  const context = elements.canvas.getContext('2d');
  if (!context) return;

  elements.canvas.width = viewport.width;
  elements.canvas.height = viewport.height;
  elements.viewerPlaceholder.classList.add('hidden');

  await page.render({
    canvasContext: context,
    viewport,
  }).promise;

  updatePageMeta();
}

async function goToPage(pageNumber) {
  if (!state.pdfDoc) return;
  state.currentPage = Math.max(1, Math.min(state.totalPages, pageNumber));
  await renderCurrentPage();
}

async function loadPdf(file) {
  if (!file) return;

  state.file = file;
  elements.dropLabel.textContent = file.name;
  elements.viewerTitle.textContent = file.name;
  if (!elements.titleInput.value.trim()) {
    elements.titleInput.value = file.name.replace(/\.pdf$/i, '');
  }

  const bytes = await file.arrayBuffer();
  const loadingTask = pdfjsLib.getDocument({ data: bytes });
  state.pdfDoc = await loadingTask.promise;
  state.totalPages = state.pdfDoc.numPages;
  state.currentPage = state.totalPages;

  elements.tocPage.max = String(state.totalPages);
  elements.tocPage.value = String(state.totalPages);
  updatePageMeta();
  await renderCurrentPage();
  setStatus('');
}

function bindDragAndDrop() {
  const zone = elements.dropZone;
  const activeClass = 'is-dragover';

  ['dragenter', 'dragover'].forEach((eventName) => {
    zone.addEventListener(eventName, (event) => {
      event.preventDefault();
      zone.classList.add(activeClass);
    });
  });

  ['dragleave', 'drop'].forEach((eventName) => {
    zone.addEventListener(eventName, (event) => {
      event.preventDefault();
      zone.classList.remove(activeClass);
    });
  });

  zone.addEventListener('drop', (event) => {
    const file = event.dataTransfer?.files?.[0];
    if (!file || file.type !== 'application/pdf') {
      setStatus('Only PDF files are supported.', true);
      return;
    }

    loadPdf(file).catch((error) => {
      setStatus(error.message || 'Failed to load PDF.', true);
    });
  });
}

async function ingestCurrentPdf() {
  if (!state.file || !state.pdfDoc) {
    setStatus('Select a PDF first.', true);
    return;
  }

  const tocPagePdf = Number(elements.tocPage.value || 0);
  if (!Number.isFinite(tocPagePdf) || tocPagePdf < 1 || tocPagePdf > state.totalPages) {
    setStatus(`TOC page must be between 1 and ${state.totalPages}.`, true);
    return;
  }

  const formData = new FormData();
  formData.set('pdf', state.file);
  formData.set('title', elements.titleInput.value.trim());
  formData.set('sectionType', getSectionTypeValue());
  formData.set('tocPagePdf', String(tocPagePdf));
  formData.set('pageOffset', String(Number(elements.pageOffset.value || 0)));

  setStatus('Uploading PDF and asking Gemini to map sections...');

  const response = await fetch('/api/documents', {
    method: 'POST',
    body: formData,
  });
  const payload = await response.json();

  if (!response.ok || !payload.ok) {
    setStatus(payload?.error || 'Failed to add textbook.', true);
    return;
  }

  setStatus(`Saved ${payload.document.title}. Mapped ${payload.document.sectionCount} sections.`);
  await loadDocuments();
}

function renderDocuments(documents) {
  elements.documentsList.innerHTML = '';

  if (!Array.isArray(documents) || documents.length === 0) {
    elements.documentsList.innerHTML = '<div class="empty-state">No textbooks loaded yet.</div>';
    return;
  }

  for (const docMeta of documents) {
    const node = elements.documentCardTemplate.content.firstElementChild.cloneNode(true);
    node.querySelector('.document-title').textContent = docMeta.title;
    node.querySelector('.document-id').textContent = docMeta.id;
    node.querySelector('.document-link').href = `/api/documents/${encodeURIComponent(docMeta.id)}/pdf`;
    node.querySelector('.document-stats').textContent =
      `${docMeta.sectionCount} mapped • ${docMeta.cachedSectionCount} cached • offset ${docMeta.pageOffset}`;

    const rows = node.querySelector('.section-rows');
    for (const section of docMeta.sections) {
      const row = window.document.createElement('tr');

      const numberCell = window.document.createElement('td');
      numberCell.textContent = String(section.sectionNumber);

      const nameCell = window.document.createElement('td');
      nameCell.textContent = section.fullName;

      const pagesCell = window.document.createElement('td');
      pagesCell.textContent = `${section.pageStart}-${section.pageEnd}`;

      row.append(numberCell, nameCell, pagesCell);
      rows.appendChild(row);
    }

    elements.documentsList.appendChild(node);
  }
}

async function loadDocuments() {
  const response = await fetch('/api/documents');
  const payload = await response.json();

  if (!response.ok || !payload.ok) {
    elements.documentsList.innerHTML =
      `<div class="empty-state error">${payload?.error || 'Failed to load documents.'}</div>`;
    return;
  }

  renderDocuments(payload.documents);
}

function attachEvents() {
  elements.pdfFile.addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    loadPdf(file).catch((error) => {
      setStatus(error.message || 'Failed to load PDF.', true);
    });
  });

  elements.sectionType.addEventListener('change', updateTypeVisibility);
  elements.pageOffset.addEventListener('input', updatePageMeta);
  elements.tocPage.addEventListener('input', updatePageMeta);

  elements.jumpFirst.addEventListener('click', () => {
    goToPage(1).catch(console.error);
  });

  elements.jumpLast.addEventListener('click', () => {
    goToPage(state.totalPages).catch(console.error);
  });

  elements.useCurrentPage.addEventListener('click', () => {
    if (!state.pdfDoc) return;
    elements.tocPage.value = String(state.currentPage);
    updatePageMeta();
  });

  elements.prevPage.addEventListener('click', () => {
    goToPage(state.currentPage - 1).catch(console.error);
  });

  elements.nextPage.addEventListener('click', () => {
    goToPage(state.currentPage + 1).catch(console.error);
  });

  elements.ingestButton.addEventListener('click', () => {
    ingestCurrentPdf().catch((error) => {
      setStatus(error.message || 'Failed to ingest PDF.', true);
    });
  });

  elements.refreshDocuments.addEventListener('click', () => {
    loadDocuments().catch(console.error);
  });
}

async function main() {
  updateTypeVisibility();
  bindDragAndDrop();
  attachEvents();
  await loadDocuments();
  updatePageMeta();
}

main().catch((error) => {
  console.error(error);
  setStatus(error.message || 'Failed to bootstrap UI.', true);
});
