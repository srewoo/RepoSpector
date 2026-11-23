/**
 * The slice of the Chrome extension API this extension uses. Hand-written to avoid a types
 * dependency; extend it as new APIs are used.
 */
declare namespace chrome {
  namespace runtime {
    function openOptionsPage(): Promise<void>;
    const lastError: { message?: string } | undefined;
    const id: string;
    interface MessageSender {
      id?: string;
      url?: string;
    }
    function sendMessage<T = unknown>(message: unknown): Promise<T>;
    function sendNativeMessage<T = unknown>(application: string, message: unknown): Promise<T>;
    const onMessage: { addListener(cb: (message: unknown, sender: MessageSender, reply: (response: unknown) => void) => boolean | undefined): void };
  }
  namespace offscreen {
    function hasDocument(): Promise<boolean>;
    function createDocument(p: { url: string; reasons: string[]; justification: string }): Promise<void>;
  }
  namespace storage {
    interface StorageArea {
      get(keys: string | string[]): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
    }
    const local: StorageArea;
    const session: StorageArea;
    const onChanged: { addListener(cb: (changes: Record<string, { newValue?: unknown; oldValue?: unknown }>, area: string) => void): void };
  }
  namespace permissions {
    interface Permissions {
      origins?: string[];
      permissions?: string[];
    }
    function request(p: Permissions): Promise<boolean>;
    function contains(p: Permissions): Promise<boolean>;
    function remove(p: Permissions): Promise<boolean>;
  }
  namespace scripting {
    function executeScript(p: { target: { tabId: number }; files: string[] }): Promise<unknown[]>;
  }
  namespace sidePanel {
    function setPanelBehavior(b: { openPanelOnActionClick: boolean }): Promise<void>;
  }
  namespace tabs {
    interface Tab {
      id?: number;
      url?: string;
      /** Set while a navigation has not committed yet; visible under the same host permission as url. */
      pendingUrl?: string;
      active: boolean;
    }
    function query(q: { active?: boolean; currentWindow?: boolean; lastFocusedWindow?: boolean }): Promise<Tab[]>;
    function sendMessage<T = unknown>(tabId: number, message: unknown): Promise<T>;
    const onActivated: { addListener(cb: (info: { tabId: number }) => void): void };
    const onUpdated: { addListener(cb: (tabId: number, change: { url?: string; status?: string }, tab: Tab) => void): void };
  }
}
