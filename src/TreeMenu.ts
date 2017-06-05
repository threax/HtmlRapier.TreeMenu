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
import * as domQuery from 'hr.domquery';
import * as uri from 'hr.uri';

export interface TreeMenuFolderNode {
    //Data storage
    name: string,
    children: TreeMenuNode[],
    //Needed live, will not be saved on edit
    parent: TreeMenuFolderNode;
    expanded: boolean;
    currentPage: boolean;
}

export interface TreeMenuLinkNode {
    //Data storage
    name: string,
    link: string,
    target?: string,
    //Needed live, will not be saved on edit
    parent: TreeMenuFolderNode;
    currentPage: boolean;
}

export type TreeMenuNode = TreeMenuFolderNode | TreeMenuLinkNode;

export function IsFolder(node: TreeMenuNode): node is TreeMenuFolderNode {
    return node !== undefined && (<TreeMenuFolderNode>node).children !== undefined;
}

interface TreeMenuSessionData {
    version: string;
    data: TreeMenuFolderNode;
    scrollLeft: number;
    scrollTop: number;
}

export interface MenuItemModel {
    name: string,
    urlRoot?: string,
    link?: string,
    target?: string,
    original: TreeMenuNode //The original menu item data stored in the output.
    parentItem: TreeMenuItem,
    provider: TreeMenuProvider
}

export class TreeMenuProvider {
    public static get InjectorArgs(): controller.DiFunction<any>[] {
        return [Fetcher, TreeMenuStorage];
    }

    private sessionData: TreeMenuSessionData;
    private urlRoot: string;
    private version: string;
    private pageUrl: uri.Uri;
    protected saveUrl: string;

    public constructor(private fetcher: Fetcher, private menuStore: TreeMenuStorage) {
        this.menuStore.setSerializerOptions(TreeMenuProvider.serializerReplace);
    }

    public async loadMenu(url: string, version: string, urlRoot: string) {
        var rootNode: TreeMenuFolderNode;

        this.saveUrl = url;
        this.pageUrl = new uri.Uri();
        this.urlRoot = urlRoot;
        this.version = version;
        this.sessionData = this.menuStore.getValue(null);

        if (this.sessionData === null || version === undefined || this.sessionData.version !== version) {
            //No data, get it
            try {
                rootNode = await http.get<TreeMenuFolderNode>(url, this.fetcher);
                rootNode.expanded = true;
            }
            catch (err) {
                rootNode = {
                    name: "Root",
                    children: [{
                        "name": "Main Page",
                        "link": "/",
                        parent: undefined,
                        currentPage: false
                    }],
                    parent: undefined,
                    expanded: true,
                    currentPage: false
                };
            }
            this.sessionData = {
                data: rootNode,
                scrollLeft: 0,
                scrollTop: 0,
                version: version
            };
        }

        //Always have to recalculate parents, since they can't be saved due to circular refs
        this.setupRuntimeInfo(this.RootNode, undefined);
    }

    public cacheMenu(scrollLeft: number, scrollTop: number) {
        var cacheData = {
            data: this.sessionData.data,
            version: this.version,
            scrollLeft: scrollLeft,
            scrollTop: scrollTop
        };
        this.menuStore.setValue(cacheData);
    }

    /**
     * This function is called when something causes the menu or part of the menu to rebuild.
     */
    public menuRebuilt() {

    }

    private setupRuntimeInfo(node: TreeMenuNode, parent: TreeMenuFolderNode) {
        node.parent = parent;
        if (IsFolder(node)) {
            var children = node.children;
            for (var i = 0; i < children.length; ++i) {
                //Recursion, I don't care, how nested is your menu that you run out of stack space here? Can a user really use that?
                this.setupRuntimeInfo(children[i], node);
            }
        }
        else { //Page link, check to see if it is the current page
            node.currentPage = node.link === this.pageUrl.path;
            if (node.currentPage) {
                //If page is the current page, set it and all its parents to expanded
                this.setParentsCurrent(node.parent);
            }
        }
    }

    private setParentsCurrent(node: TreeMenuFolderNode) {
        while (node) {
            node.expanded = true;
            node.currentPage = true;
            node = node.parent;
        }
    }

    private static serializerReplace(key: string, value: any) {
        return key !== 'parent' && key !== 'currentPage' ? value : undefined;
    }

    get RootNode(): TreeMenuFolderNode {
        return this.sessionData.data;
    }

    get ScrollLeft(): number {
        return this.sessionData.scrollLeft;
    }

    get ScrollTop(): number {
        return this.sessionData.scrollTop;
    }
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
    scrollelement?: string;
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
    private scrollElement: HTMLElement;

    public constructor(private bindings: controller.BindingCollection, protected treeMenuProvider: TreeMenuProvider, private builder: controller.InjectedControllerBuilder) {
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

        if (config.scrollelement) {
            var node = domQuery.first(config.scrollelement);
            if (node instanceof HTMLElement) {
                this.scrollElement = node;
            }
            else if (node) {
                throw new Error("Scroll element " + config.scrollelement + " is not an HTMLElement.");
            }
        }

        this.loadMenu();
    }

    private async loadMenu() {
        await this.treeMenuProvider.loadMenu(this.ajaxurl, this.version, this.urlRoot);

        //Only cache menus that loaded correctly
        window.addEventListener("beforeunload", e => {
            //Cheat to handle scroll position, using handles
            var scrollLeft = 0;
            var scrollTop = 0;
            if (this.scrollElement) {
                scrollLeft = this.scrollElement.scrollLeft;
                scrollTop = this.scrollElement.scrollTop;
            }

            this.treeMenuProvider.cacheMenu(scrollLeft, scrollTop);
        });

        //Build child tree nodes
        this.buildMenu();

        //Now that the menu is built, restore the scroll position
        if (this.scrollElement) {
            this.scrollElement.scrollLeft = this.treeMenuProvider.ScrollLeft;
            this.scrollElement.scrollTop = this.treeMenuProvider.ScrollTop;
        }
    }

    private buildMenu() {
        //Build child tree nodes
        var rootNode = this.treeMenuProvider.RootNode;
        var rootData: MenuItemModel = {
            original: rootNode,
            name: rootNode.name,
            link: undefined,
            target: undefined,
            urlRoot: this.urlRoot,
            parentItem: undefined,
            provider: this.treeMenuProvider
        };
        this.rootModel.setData(rootData, this.builder.createOnCallback(TreeMenuItem), RootVariant);
    }

    protected rebuildMenu() {
        this.buildMenu();
        this.treeMenuProvider.menuRebuilt();
    }
}

export class TreeMenuItem {
    public static get InjectorArgs(): controller.DiFunction<any>[] {
        return [controller.BindingCollection, controller.InjectControllerData, controller.InjectedControllerBuilder];
    }

    private folder: TreeMenuFolderNode;
    private loadedChildren = false;
    private childToggle: controller.OnOffToggle;
    private childModel: controller.Model<MenuItemModel>;

    public constructor(private bindings: controller.BindingCollection, protected folderMenuItemInfo: MenuItemModel, private builder: controller.InjectedControllerBuilder) {
        this.childModel = this.bindings.getModel<MenuItemModel>("children");
        if (IsFolder(folderMenuItemInfo.original)) {
            this.folder = folderMenuItemInfo.original;
        }
        this.childToggle = bindings.getToggle("children");
        var currentToggle = bindings.getToggle("current");
        currentToggle.mode = folderMenuItemInfo.original.currentPage;
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

    private buildChildren(): void {
        if (this.folder && !this.loadedChildren) {
            this.loadedChildren = true;
            //Select nodes, treat all nodes as link nodes
            var childIter = new iter.Iterable(<TreeMenuLinkNode[]>this.folder.children).select<MenuItemModel>(i => {
                return {
                    original: i,
                    name: i.name,
                    link: i.link,
                    target: i.target ? i.target : "_self",
                    urlRoot: this.folderMenuItemInfo.urlRoot,
                    parentItem: this,
                    provider: this.folderMenuItemInfo.provider
                };
            });
            this.childModel.setData(childIter, this.builder.createOnCallback(TreeMenuItem), VariantFinder);
        }
    }

    /**
     * Rebuild the children for this menu item
     * @param node - The menu node to stop at and rebuild. Will do nothing if the node cannot be found.
     */
    protected rebuildParent(node: TreeMenuNode): void {
        if (this.folderMenuItemInfo.original == node) {
            this.loadedChildren = false;
            this.buildChildren();
            this.folderMenuItemInfo.provider.menuRebuilt();
        }
        else {
            var parent = this.folderMenuItemInfo.parentItem;
            if (parent) {
                parent.rebuildParent(node);
            }
        }
    }
}

export class TreeMenuStorage extends storage.JsonStorage<TreeMenuSessionData> {
    constructor(storageDriver: storage.IStorageDriver) {
        super(storageDriver)
    }
}

/**
 * Add the default services for the tree menu. Note this will create a default storage for the
 * menu in sesssion storage called defaultTreeMenu. If you only have one tree menu per page
 * this should be fine, otherwise inject your own TreeMenuStorage with a unique name.
 * @param services
 */
export function addServices(services: controller.ServiceCollection) {
    services.tryAddTransient(TreeMenuStorage, s => new TreeMenuStorage(new storage.SessionStorageDriver("defaultTreeMenu"))); //Create a default session storage, users are encouraged to make their own
    services.tryAddTransient(TreeMenuProvider, TreeMenuProvider);
    services.tryAddTransient(TreeMenu, TreeMenu);
    services.tryAddTransient(TreeMenuItem, TreeMenuItem);
}