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

interface TreeMenuFolderNode {
    //Data storage
    name: string,
    children: TreeMenuNode[],
    //Needed live, will not be saved on edit
    parent: TreeMenuFolderNode;
    expanded: boolean;
}

interface TreeMenuLinkNode {
    //Data storage
    name: string,
    link: string,
    target?: string,
    //Needed live, will not be saved on edit
    parent: TreeMenuFolderNode;
    currentPage: boolean;
}

type TreeMenuNode = TreeMenuFolderNode | TreeMenuLinkNode;

function IsFolder(node: TreeMenuNode): node is TreeMenuFolderNode {
    return node !== undefined && (<TreeMenuFolderNode>node).children !== undefined;
}

interface TreeMenuSessionData {
    version: string;
    data: TreeMenuFolderNode;
    scrollLeft: number;
    scrollTop: number;
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

    private sessionData: TreeMenuSessionData;
    private menuStorageId: string;
    private urlRoot: string;
    private version: string;
    private pageUrl: uri.Uri;

    public constructor(private fetcher: Fetcher) {

    }

    public async loadMenu(url: string, version: string, urlRoot: string) {
        var rootNode: TreeMenuFolderNode;

        this.pageUrl = new uri.Uri();
        this.urlRoot = urlRoot;
        this.version = version;
        this.menuStorageId = 'treemenu-cache-' + url;
        this.sessionData = storage.getSessionObject(this.menuStorageId, null);

        if (this.sessionData === null || this.sessionData.version !== version) {
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
                    expanded: true
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
        storage.storeObjectInSession<TreeMenuSessionData>(this.menuStorageId, cacheData, this.serializerReplace);
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
                this.expandParents(node.parent);
            }
        }
    }

    private expandParents(node: TreeMenuFolderNode) {
        while (node) {
            node.expanded = true;
            node = node.parent;
        }
    }

    private serializerReplace(key: string, value: any) {
        return key !== 'parent' ? value : undefined;
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
        var rootNode = this.treeMenuProvider.RootNode;

        //Only cache menus that loaded correctly
        window.onbeforeunload = e => {
            //Cheat to handle scroll position, using handles
            var scrollLeft = 0;
            var scrollTop = 0;
            if (this.scrollElement) {
                scrollLeft = this.scrollElement.scrollLeft;
                scrollTop = this.scrollElement.scrollTop;
            }

            this.treeMenuProvider.cacheMenu(scrollLeft, scrollTop);
        }

        //Build child tree nodes
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

        //Now that the menu is built, restore the scroll position
        if (this.scrollElement) {
            this.scrollElement.scrollLeft = this.treeMenuProvider.ScrollLeft;
            this.scrollElement.scrollTop = this.treeMenuProvider.ScrollTop;
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

    public constructor(private bindings: controller.BindingCollection, private folderMenuItemInfo: MenuItemModel, private builder: controller.InjectedControllerBuilder) {
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
                    urlRoot: this.folderMenuItemInfo.urlRoot
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