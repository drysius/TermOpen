export interface AppDictionary {
  app: {
    name: string;
    boot: {
      starting: string;
      checkingUpdates: string;
      loadingData: string;
    };
    sync: {
      autoRunning: string;
      autoFailed: string;
    };
    header: {
      statusConnected: string;
      statusDisconnected: string;
      login: string;
      syncNow: string;
      hello: string;
      guest: string;
      syncing: string;
      stageUploading: string;
      stageDownloading: string;
      stageCleaningRemote: string;
      stageComplete: string;
    };
  };
  sidebar: {
    home: string;
    keychain: string;
    knownHosts: string;
    settings: string;
    about: string;
  };
  vault: {
    init: {
      passwordPlaceholder: string;
      confirmPlaceholder: string;
      submit: string;
      mismatch: string;
    };
    unlock: {
      passwordPlaceholder: string;
      submit: string;
      forgotPassword: string;
    };
    forgot: {
      title: string;
      description: string;
      warning: string;
      explanation: string;
      confirmLabel: string;
      confirmPlaceholder: string;
      confirmPhrase: string;
      confirmError: string;
      deleting: string;
      deleteButton: string;
      deleteSuccess: string;
    };
    recovery: {
      loginButton: string;
      title: string;
      description: string;
      serverLabel: string;
      selectServer: string;
      invalidServer: string;
      enterPassword: string;
      connecting: string;
      loginGoogle: string;
      validating: string;
      restoreButton: string;
      downloading: string;
      backupFound: string;
      downloadingInfo: string;
      downloadingWait: string;
      restoreSuccess: string;
      limitReached: string;
      attempts: string;
    };
    toasts: {
      initialized: string;
      unlocked: string;
      lockedInactivity: string;
      syncStartup: string;
      syncConflicts: string;
      conflictsResolved: string;
    };
  };
  home: {
    stats: {
      hosts: string;
      hostsSub: string;
      sessions: string;
      sessionsSub: string;
      sync: string;
      syncConnected: string;
      syncDisconnected: string;
      vault: string;
      vaultInitialized: string;
      vaultPending: string;
      vaultLocked: string;
      vaultUnlocked: string;
    };
    hosts: {
      title: string;
      newHost: string;
      emptyTitle: string;
      emptyDescription: string;
      addButton: string;
      clickToOpen: string;
      edit: string;
      remove: string;
    };
    sftp: {
      title: string;
      newSftp: string;
      emptyTitle: string;
      emptyDescription: string;
      addButton: string;
      clickToOpen: string;
      edit: string;
      remove: string;
    };
    sessionsCard: {
      title: string;
      active: string;
      empty: string;
    };
    connections: {
      title: string;
      subtitle: string;
      zeroLabel: string;
      newConnection: string;
      createFirst: string;
      emptyTitle: string;
      emptyDescription: string;
      openSsh: string;
      openSftp: string;
      quickActions: string;
      cardHint: string;
      protocolSsh: string;
      protocolSftp: string;
      protocolBoth: string;
    };
  };
  settings: {
    save: string;
    sections: {
      application: string;
      sync: string;
      sftp: string;
      terminal: string;
      modifiedFiles: string;
      googleDrive: string;
      masterPassword: string;
    };
    editor: {
      title: string;
      description: string;
      internal: string;
      vscode: string;
      system: string;
    };
    externalCommand: {
      title: string;
      description: string;
      placeholder: string;
    };
    inactivityLock: {
      title: string;
      description: string;
    };
    syncAuto: {
      title: string;
      description: string;
    };
    syncStartup: {
      title: string;
      description: string;
    };
    syncOnSave: {
      title: string;
      description: string;
    };
    syncInterval: {
      title: string;
      description: string;
    };
    sftpChunk: {
      title: string;
      description: string;
    };
    autoReconnect: {
      title: string;
      description: string;
    };
    reconnectDelay: {
      title: string;
      description: string;
    };
    copyOnSelect: {
      title: string;
      description: string;
    };
    rightClickPaste: {
      title: string;
      description: string;
    };
    ctrlShiftShortcuts: {
      title: string;
      description: string;
    };
    knownHosts: {
      title: string;
      description: string;
      placeholder: string;
      selectButton: string;
      selectDialog: string;
    };
    uploadPolicy: {
      title: string;
      description: string;
      auto: string;
      ask: string;
      manual: string;
      modalTitle: string;
      modalDescription: string;
    };
    drive: {
      tabAccount: string;
      tabServer: string;
      connected: string;
      userLabel: string;
      lastSync: string;
      connecting: string;
      reconnect: string;
      connect: string;
      cancel: string;
      push: string;
      pull: string;
      serverSearch: string;
      serverFilterAll: string;
      serverFilterOnline: string;
      serverFilterOffline: string;
      serverEmpty: string;
      serverCount: string;
      serverPrev: string;
      serverNext: string;
      official: string;
      active: string;
      offline: string;
    };
    password: {
      currentPlaceholder: string;
      newPlaceholder: string;
      confirmPlaceholder: string;
      updateButton: string;
    };
  };
  keychain: {
    title: string;
    newKey: string;
    edit: string;
    remove: string;
    password: string;
    privateKey: string;
    publicKey: string;
    passphrase: string;
    emptyTitle: string;
    emptyDescription: string;
    addFirst: string;
    typePassword: string;
    typeSshKey: string;
    typeSecret: string;
    drawer: {
      titleEdit: string;
      titleNew: string;
      description: string;
      typeLabel: string;
      namePlaceholder: string;
      passwordPlaceholder: string;
      passphrasePlaceholder: string;
      privateKeyPlaceholder: string;
      publicKeyPlaceholder: string;
      descriptionPassword: string;
      descriptionSshKey: string;
      descriptionSecret: string;
      cancel: string;
      save: string;
    };
  };
  knownHosts: {
    title: string;
    description: string;
    refresh: string;
    createFile: string;
    pathLabel: string;
    pathDefault: string;
    headerType: string;
    headerActions: string;
    removeTooltip: string;
    empty: string;
  };
  about: {
    title: string;
    description: string;
    projectSection: string;
    repoLabel: string;
    versionLabel: string;
    updatesInfo: string;
    stackSection: string;
    syncSection: string;
    syncDescription: string;
    syncConfig: string;
  };
  hostDrawer: {
    titleEdit: string;
    titleNew: string;
    description: string;
    name: { label: string; description: string; placeholder: string };
    host: { label: string; description: string; placeholder: string };
    port: { label: string; description: string; placeholder: string };
    username: { label: string; description: string; placeholder: string };
    remotePath: { label: string; description: string; placeholder: string };
    protocols: {
      label: string;
      description: string;
      placeholder: string;
      sshDescription: string;
      sftpDescription: string;
    };
    password: { label: string; description: string; placeholder: string };
    keychainField: { label: string; description: string; none: string };
    privateKey: {
      label: string;
      description: string;
      selectFile: string;
      noFile: string;
      placeholder: string;
    };
    cancel: string;
    save: string;
  };
  workspace: {
    modeFree: string;
    modeGrid: string;
    addBlock: string;
    newBlockTitle: string;
    newBlockDescription: string;
    blockSftp: string;
    blockTerminal: string;
    transfer: string;
    transferFolder: string;
    transferSuccess: string;
    closeTitle: string;
    closeMessage: string;
    closing: string;
    closeConfirm: string;
  };
  editor: {
    save: string;
    openExternal: string;
    imageError: string;
    videoError: string;
  };
  conflicts: {
    title: string;
    description: string;
    applying: string;
    applyButton: string;
    keepClient: string;
    keepServer: string;
    local: string;
    server: string;
    absent: string;
  };
  toasts: {
    connectionSaved: string;
    connectionRemoved: string;
    keychainSaved: string;
    keychainRemoved: string;
    settingsSaved: string;
    enterNewPassword: string;
    passwordMismatch: string;
    passwordUpdated: string;
    sessionDisconnected: string;
    sessionReconnecting: string;
    sessionReconnected: string;
    unknownHostConfirm: string;
    connectionCancelledHost: string;
    passwordPrompt: string;
    connectionCancelledPassword: string;
    savePasswordConfirm: string;
    connectionFailed: string;
    selectSourceFile: string;
    fileCopied: string;
    textOnlyEditor: string;
    fileSaved: string;
    mediaCantExport: string;
    fileTooLarge: string;
  };
  common: {
    cancel: string;
    save: string;
    edit: string;
    remove: string;
    close: string;
    select: string;
    loading: string;
  };
}
