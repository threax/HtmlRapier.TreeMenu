"use strict";

import * as storage from "hr.storage";
import * as http from "hr.http";
import * as controller from "hr.controller";
import * as EventDispatcher from 'hr.eventdispatcher';
import * as ObservableList from 'hr.observablelist';
import {Fetcher} from 'hr.fetcher';
import {WindowFetch} from 'hr.windowfetch';
import {CacheBuster} from 'hr.cachebuster';

export interface ItemAddedArgs {
    saveUrl: string;
    itemData;
    bindListenerCb;
}

export interface CreateRootNodeControlsArgs {
    controllerElementName: string;
    menuData: any;
    updateCb: () => void;
    saveUrl: string;
    parentBindings: controller.BindingCollection;
    urlRoot: string;
}

export interface TreeMenuEditorSyncObserver {
    createRootNodeControls: (arg: CreateRootNodeControlsArgs) => void;
    itemAdded: (arg: ItemAddedArgs) => void;
}

class TreeMenuEditorSync {
    private rootNodeControls = new ObservableList.ObservableList<CreateRootNodeControlsArgs>();
    private items = new ObservableList.ObservableList<ItemAddedArgs>();

    alertMenuRebuilt(){
        this.items.clear(false);
    }

    fireItemAdded(saveUrl: string, itemData: any, bindListenerCb: any) {
        this.items.add({ saveUrl: saveUrl, itemData: itemData, bindListenerCb: bindListenerCb });
    }

    fireCreateRootNodeControls(controllerElementName: string, menuData: any, updateCb: any, saveUrl: string, parentBindings: any, urlRoot: string) {
        this.rootNodeControls.add({
            controllerElementName: controllerElementName,
            menuData: menuData,
            updateCb: updateCb,
            saveUrl: saveUrl,
            parentBindings: parentBindings,
            urlRoot: urlRoot
        });
    }

    setEditorListener(value: TreeMenuEditorSyncObserver, fireExisingEvents?: boolean) {
        //Important order, need to create root nodes first
        this.rootNodeControls.itemAdded.add((arg) => value.createRootNodeControls(arg));
        this.items.itemAdded.add((arg) => value.itemAdded(arg));

        if (fireExisingEvents) {
            this.rootNodeControls.iter.forEach((i) => {
                value.createRootNodeControls(i);
            });

            this.items.iter.forEach((i) => {
                value.itemAdded(i);
            });
        }
    }
}

export function isFolder(menuItem) {
    return !menuItem.hasOwnProperty("link");
}

interface TreeMenuSessionData {
    version;
    cache;
    data;
};

var treeMenuInstances = new ObservableList.ObservableList<TreeMenuController>();

export function GetInstances() {
    return treeMenuInstances.iter;
}

export function GetInstanceAdded() {
    return treeMenuInstances.itemAdded;
}

interface TreeMenuControllerOptions{
    /**
     * The fetcher to use to recover data.
     */
    fetcher: Fetcher;
}

export class TreeMenuController {
    static GetBuilder(context?:TreeMenuControllerOptions) {
        return new controller.ControllerBuilder<TreeMenuController, TreeMenuControllerOptions, void>(TreeMenuController, context);
    }

    private bindings: controller.BindingCollection;
    private rootModel;
    private config;
    private editMode;
    private version;
    private urlRoot: string;
    private editorSync = new TreeMenuEditorSync();

    private ajaxurl;
    private getNextId = (function () {
        var i = -1;
        return function () {
            return ++i;
        }
    })();

    private menuStorageId;
    private sessionData: TreeMenuSessionData;
    private menuCache = null;
    private menuData = null;
    private createdItems = {};
    private fetcher:Fetcher = undefined;

    constructor(bindings: controller.BindingCollection, context?:TreeMenuControllerOptions) {
        if(context !== undefined){
            this.fetcher = context.fetcher;
        }
        if(this.fetcher === undefined){
            this.fetcher = new CacheBuster(new WindowFetch());
        }
        this.bindings = bindings;
        treeMenuInstances.add(this);

        this.rootModel = bindings.getModel('children');
        this.config = bindings.getConfig();
        this.editMode = this.config["treemenu-editmode"] === 'true';
        this.version = this.config["treemenu-version"];
        this.urlRoot = this.config["urlroot"];
        if (this.urlRoot === undefined) {
            this.urlRoot = "";
        }
        if (this.urlRoot.length > 0) {
            var lastChar = this.urlRoot[this.urlRoot.length - 1];
            if (lastChar === '\\' || lastChar === '/') {
                this.urlRoot = this.urlRoot.substr(0, this.urlRoot.length - 1);
            }
        }
        this.ajaxurl = this.rootModel.getSrc();
        this.menuStorageId = 'treemenu-cache-' + this.ajaxurl;
        this.sessionData = storage.getSessionObject(this.menuStorageId, null);

        window.onbeforeunload = (e) => {
            if (this.editMode) {
                this.removeParents(this.menuData);
            }
            storage.storeObjectInSession<TreeMenuSessionData>(this.menuStorageId, {
                cache: this.menuCache,
                data: this.menuData,
                version: this.version
            });
        };

        if (this.sessionData === null || this.sessionData.version !== this.version) {
            //No data, get it
            this.menuCache = {
            };
            http.get(this.ajaxurl, this.fetcher)
                .then((data) => {
                    this.initialSetup(data);
                });
        }
        else {
            //Use what we had
            this.menuCache = this.sessionData.cache;
            this.initialSetup(this.sessionData.data);
        }
    }

    initialSetup(data) {
        this.menuData = data;
        if (this.menuData !== null) {
            this.setupLiveMenuItems(data);

            if (this.editMode) {
                this.findParents(data, null);
                this.editorSync.fireCreateRootNodeControls("treeMenuEditRoot", this.menuData, () => this.rebuildMenu(), this.ajaxurl, this.bindings, this.urlRoot); //This isn't really right, will create controllers for all tree menus on the page, need to single out somehow
            }

            var menuCacheInfo = this.getMenuCacheInfo(data.menuItemId);
            this.buildMenu(this.bindings, menuCacheInfo, this.menuData, false);
        }
    }

    get EditorSync() {
        return this.editorSync;
    }

    private rebuildMenu() {
        if(this.editMode){
            this.editorSync.alertMenuRebuilt();
        }
        this.createdItems = {};
        var childModel = this.bindings.getModel('children');
        childModel.setData([]);
        this.setupLiveMenuItems(this.menuData);
        var menuCacheInfo = this.getMenuCacheInfo(this.menuData.menuItemId);
        this.buildMenu(this.bindings, menuCacheInfo, this.menuData, false);
    }

    /**
     * The configuration for items from the server is not 100%, fill in the missing info here.
     */
    private setupLiveMenuItems(data) {
        if (isFolder(data)) {
            if (data['menuItemId'] === undefined) {
                data.menuItemId = this.getNextId();
            }
            var children = data.children;
            for (var i = 0; i < children.length; ++i) {
                //Recursion, I don't care, how nested is your menu that you run out of stack space here? Can a user really use that?
                this.setupLiveMenuItems(children[i]);
            }
        }
        else {
            //Set url root on links
            data.urlRoot = this.urlRoot;
        }
    }

    private findParents(data, parent) {
        data.parent = parent;
        var children = data.children;
        if (children) {
            for (var i = 0; i < children.length; ++i) {
                //Recursion, I don't care, how nested is your menu that you run out of stack space here? Can a user really use that?
                this.findParents(children[i], data);
            }
        }
    }

    private removeParents(data) {
        delete data.parent;
        var children = data.children;
        if (children) {
            for (var i = 0; i < children.length; ++i) {
                //Recursion, I don't care, how nested is your menu that you run out of stack space here? Can a user really use that?
                this.removeParents(children[i]);
            }
        }
    }

    private getMenuCacheInfo(parentCategoryId) {
        if (!this.menuCache.hasOwnProperty(parentCategoryId)) {
            this.menuCache[parentCategoryId] = {
                expanded: false,
                id: parentCategoryId
            };
        }
        return this.menuCache[parentCategoryId];
    }

    private buildMenu(parentBindings: controller.BindingCollection, menuCacheInfo, folder, autoHide?: boolean) {
        if (autoHide === undefined) {
            autoHide = true;
        }

        if (!this.createdItems[menuCacheInfo.id]) {
            var parentModel = parentBindings.getModel('children');
            var list: controller.BindingCollection = null;
            parentModel.setData({
            }, function (created: controller.BindingCollection) {
                list = created;
            });
            this.createdItems[menuCacheInfo.id] = true;

            var childItemsModel = list.getModel('childItems');

            childItemsModel.setData(folder.children, (folderComponent: controller.BindingCollection, data) => {
                var id = data.menuItemId;
                if (this.editMode) {
                    this.editorSync.fireItemAdded(this.ajaxurl, data, (editListener) => { folderComponent.setListener(editListener); });
                }
                if(id !== undefined){
                    var menuCacheInfo = this.getMenuCacheInfo(id);
                    var childToggle = folderComponent.getToggle('children');

                    var listener = {
                        toggleMenuItem: (evt) => {
                            evt.preventDefault();

                            this.buildMenu(folderComponent, menuCacheInfo, data);
                            this.toggleMenu(menuCacheInfo, childToggle);
                        }
                    };
                    folderComponent.setListener(listener);

                    if (menuCacheInfo.expanded) {
                        this.buildMenu(folderComponent, menuCacheInfo, data, autoHide);
                    }
                }
            }, (row) => {
                if (!isFolder(row)) {
                    return "link";
                }
            });
        }
    }

    private toggleMenu(menuCacheInfo, toggle, transitionTime?: number) {
        if (transitionTime === undefined) {
            transitionTime = 200;
        }

        if (menuCacheInfo.expanded) {
            menuCacheInfo.expanded = false;
            toggle.off();
        }
        else {
            menuCacheInfo.expanded = true;
            toggle.on();
        }
    }
}