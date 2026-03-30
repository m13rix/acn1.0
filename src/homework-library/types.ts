export interface HomeworkDocumentSection {
  sectionNumber: number;
  fullName: string;
  pageStart: number;
  pageEnd: number;
  pdfPageStart: number;
  pdfPageEnd: number;
}

export interface HomeworkSectionCacheEntry {
  sectionNumber: number;
  cacheFile: string;
  cachedAt: string;
  charCount: number;
  version?: number;
  strategy?: string;
}

export interface HomeworkDocumentMetadata {
  id: string;
  title: string;
  originalFilename: string;
  sectionType: string;
  tocPagePdf: number | null;
  tocPageLogical: number | null;
  pageOffset: number;
  pageCount: number;
  createdAt: string;
  updatedAt: string;
  model: string;
  tocInputMode?: 'page' | 'text';
  sections: HomeworkDocumentSection[];
  cachedSections: Record<string, HomeworkSectionCacheEntry>;
}

export interface HomeworkDocumentSummary {
  id: string;
  title: string;
  originalFilename: string;
  sectionType: string;
  tocPagePdf: number | null;
  tocPageLogical: number | null;
  pageOffset: number;
  pageCount: number;
  createdAt: string;
  updatedAt: string;
  sectionCount: number;
  cachedSectionCount: number;
  sections: HomeworkDocumentSection[];
}

export interface CreateHomeworkDocumentInput {
  title?: string;
  originalFilename: string;
  pdfBuffer: Buffer;
  tocPagePdf?: number;
  tocText?: string;
  pageOffset: number;
  sectionType: string;
}
