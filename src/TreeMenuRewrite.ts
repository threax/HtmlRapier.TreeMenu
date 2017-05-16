"use strict";

import * as storage from "hr.storage";
import * as http from "hr.http";
import * as controller from "hr.controller";
import * as EventDispatcher from 'hr.eventdispatcher';
import * as ObservableList from 'hr.observablelist';
import { Fetcher } from 'hr.fetcher';
import { WindowFetch } from 'hr.windowfetch';
import { CacheBuster } from 'hr.cachebuster';
import * as iter from 'hr.iterable';

interface TreeMenuFolderNode {
    //Data storage
    name: string,
    children: TreeMenuNode[],
    //Needed live, will not be saved
    parent: TreeMenuNode;
    menuItemId: number;
    expanded: boolean;
}

interface TreeMenuLinkNode {
    //Data storage
    name: string,
    link: string,
    target?: string,
    //Needed live, will not be saved
    parent: TreeMenuNode;
    urlRoot: string;
}

type TreeMenuNode = TreeMenuFolderNode | TreeMenuLinkNode;

function IsFolder(node: TreeMenuNode): node is TreeMenuFolderNode{
    return node !== undefined && (<TreeMenuFolderNode>node).children !== undefined;
}

interface TreeMenuSessionData {
    version;
    cache;
    data;
};

interface MenuCacheInfo {
    id: number;
}

interface CreatedItems {
    [key: string]: boolean;
}

interface MenuItemModel {
    name: string,
    urlRoot?: string,
    link?: string,
    target?: string,
    original: TreeMenuNode //The original menu item data stored in the output.
}

class TreeMenuProvider {
    public static get InjectorArgs(): controller.DiFunction<any>[] {
        return [Fetcher];
    }

    private menuCache = null;
    private rootNode: TreeMenuFolderNode;
    private sessionData: TreeMenuSessionData;
    private menuStorageId: string;
    private urlRoot: string;
    private version: string;

    public constructor(private fetcher: Fetcher) {

    }

    public async loadMenu(url: string, version: string, urlRoot: string) {
        this.urlRoot = urlRoot;
        this.version = version;
        this.menuStorageId = 'treemenu-cache-' + url;
        this.sessionData = storage.getSessionObject(this.menuStorageId, null);

        if (this.sessionData === null || this.sessionData.version !== version) {
            //No data, get it
            try {
                this.menuCache = {};
                this.rootNode = await http.get<TreeMenuFolderNode>(url, this.fetcher);
                this.rootNode.expanded = true;
            }
            catch (err) {
                this.rootNode = {
                    name: "Root",
                    children: [{
                        "name": "Main Page",
                        "link": "/",
                        parent: undefined,
                        urlRoot: undefined
                    }],
                    parent: undefined,
                    menuItemId: undefined,
                    expanded: true
                };
            }
        }
        else {
            //Use what we had
            this.menuCache = this.sessionData.cache;
            this.rootNode = this.sessionData.data;
        }

        this.setupLiveMenuItems(this.rootNode);
    }

    public cacheMenu() {
        storage.storeObjectInSession<TreeMenuSessionData>(this.menuStorageId, {
            cache: this.menuCache,
            data: this.rootNode,
            version: this.version
        });
    }

    private setupLiveMenuItems(node: TreeMenuNode) {
        if (IsFolder(node)) {
            if (node.menuItemId === undefined) {
                node.menuItemId = this.getNextId();
            }
            var children = node.children;
            if (children) {
                for (var i = 0; i < children.length; ++i) {
                    //Recursion, I don't care, how nested is your menu that you run out of stack space here? Can a user really use that?
                    this.setupLiveMenuItems(children[i]);
                }
            }
        }
        else {
            //Set url root on links
            node.urlRoot = this.urlRoot;
        }
    }

    get RootNode(): TreeMenuFolderNode {
        return this.rootNode;
    }

    private getNextId = (function () {
        var i = -1;
        return function () {
            return ++i;
        }
    })();
}

function VariantFinder(node: MenuItemModel) {
    if (!IsFolder(node.original)) {
        return "link";
    }
}

function RootVariant(node: MenuItemModel) {
    return "root";
}

interface TreeMenuConfig {
    urlroot: string;
    menu: string;
}

export class TreeMenu {
    public static get InjectorArgs(): controller.DiFunction<any>[] {
        return [controller.BindingCollection, TreeMenuProvider, controller.InjectedControllerBuilder];
    }

    private rootModel: controller.Model<any>;
    private editMode: boolean;
    private version: string;
    private urlRoot: string;
    private ajaxurl: string;

    public constructor(private bindings: controller.BindingCollection, private treeMenuProvider: TreeMenuProvider, private builder: controller.InjectedControllerBuilder) {
        this.rootModel = bindings.getModel('childItems');
        var config = bindings.getConfig<TreeMenuConfig>();
        this.editMode = config["treemenu-editmode"] === 'true';
        this.version = config["treemenu-version"];
        this.ajaxurl = config.menu;
        this.urlRoot = config.urlroot;
        if (this.urlRoot === undefined) {
            this.urlRoot = "";
        }
        if (this.urlRoot.length > 0) {
            var lastChar = this.urlRoot[this.urlRoot.length - 1];
            if (lastChar === '\\' || lastChar === '/') {
                this.urlRoot = this.urlRoot.substr(0, this.urlRoot.length - 1);
            }
        }

        this.loadMenu();
    }

    private async loadMenu() {
        //No data, get it
        try {
            await this.treeMenuProvider.loadMenu(this.ajaxurl, this.version, this.urlRoot);
            var rootNode = this.treeMenuProvider.RootNode;

            window.onbeforeunload = (e) => this.treeMenuProvider.cacheMenu(); //Only cache menus that loaded correctly

            this.builder.Services.addSharedInstance(TreeMenu, this); //Ensure tree children get this TreeMenu instance.
            //Select nodes, treat all nodes as link nodes
            var rootData: MenuItemModel = {
                original: rootNode,
                name: rootNode.name,
                link: undefined,
                target: undefined,
                urlRoot: this.urlRoot
            };
            this.rootModel.setData(rootData, this.builder.createOnCallback(TreeMenuItem), RootVariant);
        }
        catch (err) {
            console.log('Error loading menu ' + err);
        }
    }
}

class TreeMenuItem {
    public static get InjectorArgs(): controller.DiFunction<any>[] {
        return [controller.BindingCollection, controller.InjectControllerData, controller.InjectedControllerBuilder];
    }

    private createdItems: CreatedItems = {};
    private folder: TreeMenuFolderNode;
    private loadedChildren = false;
    private childToggle: controller.OnOffToggle;
    private childModel: controller.Model<MenuItemModel>;

    public constructor(private bindings: controller.BindingCollection, folderMenuItemInfo: MenuItemModel, private builder: controller.InjectedControllerBuilder) {
        this.childModel = this.bindings.getModel<MenuItemModel>("children");
        if (IsFolder(folderMenuItemInfo.original)) {
            this.folder = folderMenuItemInfo.original;
        }
        this.childToggle = bindings.getToggle("children");
    }

    protected postBind() {
        if (this.folder && this.folder.expanded) {
            this.buildChildren()
            this.childToggle.on();
        }
        else {
            this.childToggle.off();
        }
    }

    public toggleMenuItem(evt: Event) {
        evt.preventDefault();
        evt.stopPropagation();
        this.buildChildren();
        this.childToggle.toggle();
        this.folder.expanded = this.childToggle.mode;
    }

    private buildChildren() {
        if (this.folder && !this.loadedChildren) {
            this.loadedChildren = true;
            //Select nodes, treat all nodes as link nodes
            var childIter = new iter.Iterable(<TreeMenuLinkNode[]>this.folder.children).select<MenuItemModel>(i => {
                return {
                    original: i,
                    name: i.name,
                    link: i.link,
                    target: i.target ? i.target : "_self",
                    urlRoot: i.urlRoot
                };
            });
            this.childModel.setData(childIter, this.builder.createOnCallback(TreeMenuItem), VariantFinder);
        }
    }
}

export function addServices(services: controller.ServiceCollection) {
    services.tryAddShared(Fetcher, s => new CacheBuster(new WindowFetch()));
    services.addTransient(TreeMenuProvider, TreeMenuProvider);
    services.addTransient(TreeMenu, TreeMenu);
    services.addTransient(TreeMenuItem, TreeMenuItem);
}