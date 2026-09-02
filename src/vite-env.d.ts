/// <reference types="vite/client" />

type OpenedFile = {
  filePath: string;
  content: string;
};

type SavePayload = {
  filePath?: string | null;
  content: string;
};

type SaveResult = {
  filePath: string;
} | null;

interface Window {
  mdApi: {
    openFile: () => Promise<OpenedFile | null>;
    readFile: (filePath: string) => Promise<OpenedFile>;
    saveFile: (payload: SavePayload) => Promise<SaveResult>;
    saveFileAs: (payload: SavePayload) => Promise<SaveResult>;
    confirmDiscard: () => Promise<boolean>;
    setTitle: (title: string) => void;
    applyTheme: (theme: string, backgroundColor: string) => void;
    pathForFile: (file: File) => string;
    getPendingFile: () => Promise<OpenedFile | null>;
    onOpenedFromOs: (callback: (file: OpenedFile) => void) => () => void;
    onMenuAction: (callback: (action: string) => void) => () => void;
  };
}
