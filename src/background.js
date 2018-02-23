const delay = require('delay');
const Storage = require('./background/storage');
const Container = require('./background/container');
const Request = require('./background/request');
const MouseClick = require('./background/mouseclick');
const Emittery = require('emittery');
const MultiAccountContainers = require('./background/mac');
const { versionCompare } = require('./background/utils');
const {
  log,
  debug
} = require('./background/log');


class TemporaryContainers extends Emittery {
  constructor() {
    super();
    this.noContainerTabs = {};

    this.storage = new Storage;
    this.request = new Request;
    this.container = new Container;
    this.mouseclick = new MouseClick;
    this.mac = new MultiAccountContainers;
    this.macLegacy = false;
  }


  async initialize() {
    // TODO cache history permission in storage when firefox bug is fixed
    // https://bugzilla.mozilla.org/show_bug.cgi?id=1283320
    this.permissions = {
      history: await browser.permissions.contains({permissions: ['history']}),
      notifications: await browser.permissions.contains({permissions: ['notifications']})
    };

    this.request.initialize(this);
    this.container.initialize(this);
    this.mouseclick.initialize(this);
    this.mac.initialize(this);
    if (!this.storage.local) {
      await this.storage.load();
    }

    browser.contextMenus.onClicked.addListener(this.contextMenusOnClicked.bind(this));
    browser.commands.onCommand.addListener(this.commandsOnCommand.bind(this));
    browser.tabs.onActivated.addListener(this.tabsOnActivated.bind(this));
    browser.windows.onFocusChanged.addListener(this.windowsOnFocusChanged.bind(this));
    browser.runtime.onMessage.addListener(this.runtimeOnMessage.bind(this));
    browser.runtime.onMessageExternal.addListener(this.runtimeOnMessageExternal.bind(this));
    browser.tabs.onCreated.addListener(this.tabsOnCreated.bind(this));
    browser.tabs.onUpdated.addListener(this.tabsOnUpdated.bind(this));
    browser.tabs.onRemoved.addListener(this.tabsOnRemoved.bind(this));
    browser.browserAction.onClicked.addListener(this.browserActionOnClicked.bind(this));
    this.addContextMenu();

    if (this.storage.local.preferences.iconColor !== 'default') {
      this.setIcon(this.storage.local.preferences.iconColor);
    }
  }

  async runtimeOnMessage(message, sender) {
    if (typeof message !== 'object') {
      return;
    }

    switch (message.method) {
    case 'linkClicked':
      debug('[browser.runtime.onMessage] message from userscript received', message, sender);
      this.mouseclick.linkClicked(message.payload, sender);
      break;

    case 'savePreferences':
      debug('[browser.runtime.onMessage] saving preferences', message, sender);
      if (this.storage.local.preferences.iconColor !== message.payload.preferences.iconColor) {
        this.setIcon(message.payload.preferences.iconColor);
      }
      if (message.payload.preferences.notifications) {
        this.permissions.notifications = true;
      }
      this.storage.local.preferences = message.payload.preferences;
      await this.storage.persist();
      break;

    case 'resetStatistics':
      this.storage.local.statistics = {
        startTime: new Date,
        containersDeleted: 0,
        cookiesDeleted: 0,
        deletesHistory: {
          containersDeleted: 0,
          cookiesDeleted: 0,
          urlsDeleted: 0
        }
      };
      await this.storage.persist();
      break;

    case 'historyPermissionAllowed':
      this.permissions.history = true;
      break;
    }

  }

  async runtimeOnMessageExternal(message, sender) {
    debug('[runtimeOnMessageExternal] got external message', message, sender);
    switch (message.method) {
    case 'createTabInTempContainer':
      this.container.createTabInTempContainer({
        url: message.url ? message.url : null,
        active: typeof message.active === 'undefined' ? true : message.active,
        deletesHistory: this.storage.local.preferences.deletesHistoryContainer === 'automatic' ? true : false
      });
      break;
    default:
      throw new Error('Unknown message.method');
    }
  }


  browserActionOnClicked(tab, url) {
    if (!this.storage.local.preferences.keyboardShortcuts.AltC) {
      return;
    }
    let deletesHistory = false;
    if (this.storage.local.preferences.deletesHistoryContainer === 'automatic') {
      deletesHistory = true;
    }
    this.container.createTabInTempContainer({tab, url, deletesHistory});
  }


  async tabsOnCreated(tab) {
    debug('[browser.tabs.onCreated] tab created', tab);
    if (tab.incognito) {
      // delay disabling of browseraction (firefox doesnt pickup disabling right after creation)
      delay(200).then(() => {
        debug('[browser.tabs.onCreated] tab is incognito, disabling browseraction', tab);
        browser.browserAction.disable(tab.id);
      });
      return;
    }

    await this.container.maybeReloadTabInTempContainer(tab);
  }


  async tabsOnUpdated(tabId, changeInfo, tab) {
    debug('[browser.tabs.onUpdated] tab updated', tab);
    if (!changeInfo.url) {
      debug('[browser.tabs.onUpdated] url didnt change, not relevant', tabId, changeInfo, tab);
      return;
    }
    debug('[tabsOnUpdated] url changed', changeInfo, tab);
    await this.container.maybeAddHistory(tab, changeInfo.url);
    await this.showOrHidePageAction(tab);
    await this.container.maybeReloadTabInTempContainer(tab);
  }


  async tabsOnRemoved(tabId) {
    if (this.noContainerTabs[tabId]) {
      delete this.noContainerTabs[tabId];
    }
    this.container.addToRemoveQueue(tabId);
  }


  async tabsOnActivated(activeInfo) {
    this.removeContextMenu();
    const activatedTab = await browser.tabs.get(activeInfo.tabId);
    if (!activatedTab.incognito) {
      this.addContextMenu();

      this.showOrHidePageAction(activatedTab);
    }
  }

  async showOrHidePageAction(activatedTab) {
    let color;
    if (activatedTab.cookieStoreId === 'firefox-default') {
      color = 'gray';
    } else if (this.storage.local.tempContainers[activatedTab.cookieStoreId] &&
               this.storage.local.tempContainers[activatedTab.cookieStoreId].color) {
      color = this.storage.local.tempContainers[activatedTab.cookieStoreId].color;
    } else {
      const container = await browser.contextualIdentities.get(activatedTab.cookieStoreId);
      color = container.color;
    }
    browser.pageAction.setIcon({
      path: {
        '19': `icons/pageaction-${color}-19.svg`,
        '38': `icons/pageaction-${color}-38.svg`
      },
      tabId: activatedTab.id
    });
    if (!this.storage.local.preferences.pageAction ||
        !activatedTab.url.startsWith('http')) {
      browser.pageAction.hide(activatedTab.id);
    } else {
      browser.pageAction.show(activatedTab.id);
    }
  }


  async windowsOnFocusChanged(windowId) {
    if (windowId === browser.windows.WINDOW_ID_NONE) {
      return;
    }
    this.removeContextMenu();
    try {
      const activeTab = await browser.tabs.query({
        active: true,
        windowId: windowId
      });
      if (!activeTab[0].incognito) {
        this.addContextMenu();
      }
    } catch (error) {
      debug('failed to get the active tab from window');
    }
  }


  async contextMenusOnClicked(info, tab) {
    let deletesHistory = false;
    if (this.storage.local.preferences.deletesHistoryContainer === 'automatic') {
      deletesHistory = true;
    }
    switch (info.menuItemId)  {
    case 'open-link-in-new-temporary-container-tab':
      this.container.createTabInTempContainer({tab, url: info.linkUrl, active: false, deletesHistory});
      break;
    }
  }


  async commandsOnCommand(name) {
    switch(name) {
    case 'new_no_container_tab':
      if (!this.storage.local.preferences.keyboardShortcuts.AltN) {
        return;
      }
      try {
        const tab = await browser.tabs.create({
          active: true,
          url: 'about:blank'
        });
        this.noContainerTabs[tab.id] = true;
        debug('[commandsOnCommand] new no container tab created', this.noContainerTabs);
      } catch (error) {
        debug('[commandsOnCommand] couldnt create tab', error);
      }
      break;

    case 'new_no_container_window_tab':
      if (!this.storage.local.preferences.keyboardShortcuts.AltShiftC) {
        return;
      }
      try {
        const window = await browser.windows.create({
          url: 'about:blank'
        });
        this.noContainerTabs[window.tabs[0].id] = true;
        debug('[commandsOnCommand] new no container tab created in window', window, this.noContainerTabs);
      } catch (error) {
        debug('[commandsOnCommand] couldnt create tab in window', error);
      }
      break;

    case 'new_no_history_tab':
      if (!this.storage.local.preferences.keyboardShortcuts.AltP) {
        return;
      }
      if (this.permissions.history) {
        this.container.createTabInTempContainer({deletesHistory: true});
      }
      break;

    case 'new_same_container_tab':
      if (!this.storage.local.preferences.keyboardShortcuts.AltX) {
        return;
      }
      this.container.createTabInSameContainer();
    }
  }

  async addContextMenu() {
    if (!this.storage.local.preferences.contextMenu) {
      return;
    }
    browser.contextMenus.create({
      id: 'open-link-in-new-temporary-container-tab',
      title: 'Open Link in New Temporary Container Tab',
      contexts: ['link'],
      icons: {
        '16': 'icons/page-w-16.svg',
        '32': 'icons/page-w-32.svg'
      }
    });
  }


  async removeContextMenu() {
    browser.contextMenus.removeAll();
  }


  setIcon(iconColor) {
    const iconPath = '../icons';
    if (iconColor === 'default') {
      iconColor = 'd';
    }
    const icon = {
      path: {
        16: `${iconPath}/page-${iconColor}-16.svg`,
        32: `${iconPath}/page-${iconColor}-32.svg`
      }
    };
    browser.browserAction.setIcon(icon);
  }

  async runtimeOnInstalled(details) {
    if (details.temporary) {
      log.DEBUG = true;
      return; // prevent update logic
    }

    if (details.reason === 'update') {
      delay(60000).then(() => this.onUpdateMigration(details));
    }
  }

  async onUpdateMigration(details) {
    if (!this.storage.local) {
      await this.storage.load();
    }
    const previousVersion = details.previousVersion.replace('beta', '.');
    debug('updated from version', details.previousVersion, previousVersion);
    if (versionCompare('0.16', previousVersion) >= 0) {
      debug('updated from version <= 0.16, adapt old automaticmode behaviour if necessary');
      if (!this.storage.local.preferences.automaticMode) {
        this.storage.local.preferences.linkClickGlobal.middle.action = 'never';
        this.storage.local.preferences.linkClickGlobal.ctrlleft.action = 'never';
        await this.storage.persist();
      }
    }
    if (versionCompare('0.33', previousVersion) >= 0) {
      debug('updated from version <= 0.33, make sure to set all left-clicks to "never"');
      this.storage.local.preferences.linkClickGlobal.left.action = 'never';
      const linkClickDomainPatterns = Object.keys(this.storage.local.preferences.linkClickDomain);
      if (linkClickDomainPatterns.length) {
        linkClickDomainPatterns.map(linkClickDomainPattern => {
          this.storage.local.preferences.linkClickDomain[linkClickDomainPattern].left.action = 'never';
        });
      }
      await this.storage.persist();
    }
    if (versionCompare('0.57', previousVersion) >= 0) {
      debug('updated from version <= 0.57, potentially inform user about automatic mode preference change');
      if (this.storage.local.preferences.automaticMode &&
          this.storage.local.preferences.automaticModeNewTab === 'navigation') {
        this.storage.local.preferences.automaticModeNewTab = 'created';
        await this.storage.persist();

        const url = browser.runtime.getURL('tmpcontainer/ui/notifications/update_from_0.57_and_below.html');
        browser.tabs.create({
          url
        });
      }
    }
  }


  async runtimeOnStartup() {
    if (!this.storage.local) {
      await this.storage.load();
    }

    // queue a container cleanup
    delay(15000).then(() => {
      this.container.cleanup(true);
    });

    // extension loads after the first tab opens most of the time
    // lets see if we can reopen the first tab
    const tempTabs = await browser.tabs.query({});
    // disable browseraction for all incognito tabs
    tempTabs.map(tab => {
      if (tab.incognito) {
        browser.browserAction.disable(tab.id);
      }
    });
    if (tempTabs.length !== 1) {
      return;
    }
    await this.container.maybeReloadTabInTempContainer(tempTabs[0]);
  }
}


const tmp = new TemporaryContainers();
browser.runtime.onInstalled.addListener(tmp.runtimeOnInstalled.bind(tmp));
browser.runtime.onStartup.addListener(tmp.runtimeOnStartup.bind(tmp));


if (!browser.mochaTest) {
  window.log = log;
  window.tmp = tmp;
  tmp.initialize();
} else {
  /* eslint-disable no-undef */
  if (process.argv[process.argv.length-1] === '--tmp-debug') {
    log.DEBUG = true;
  }
}

module.exports = tmp;
