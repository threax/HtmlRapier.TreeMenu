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
import * as TreeMenu from "hr.treemenu.TreeMenu";
import * as toggles from "hr.toggles";
import { ExternalPromise } from 'hr.externalpromise';

export class EditTreeMenu extends TreeMenu.TreeMenu {
    public static get InjectorArgs(): controller.DiFunction<any>[] {
        return [controller.BindingCollection, TreeMenu.TreeMenuProvider, controller.InjectedControllerBuilder, AddTreeMenuItemController];
    }

    public constructor(bindings: controller.BindingCollection, treeMenuProvider: TreeMenu.TreeMenuProvider, builder: controller.InjectedControllerBuilder, private addItemController: AddTreeMenuItemController) {
        super(bindings, treeMenuProvider, builder);
    }

    public async addItem(evt, menuData, itemData, urlRoot, updateCb) {
        evt.preventDefault();
        evt.stopPropagation();
        try {
            await this.addItemController.addItem(this.treeMenuProvider.RootNode); //This is always going to be a folder node if this function can be called
            this.rebuildMenu();
        }
        catch (err) {
            if (err !== AddTreeMenuItemController.CancellationToken) {
                throw err;
            }
        }
    }
}

class EditTreeMenuItem extends TreeMenu.TreeMenuItem {
    public static get InjectorArgs(): controller.DiFunction<any>[] {
        return [controller.BindingCollection, controller.InjectControllerData, controller.InjectedControllerBuilder, AddTreeMenuItemController, EditTreeMenuItemController];
    }

    public constructor(bindings: controller.BindingCollection, folderMenuItemInfo: TreeMenu.MenuItemModel, builder: controller.InjectedControllerBuilder, private addItemController: AddTreeMenuItemController, private editItemController: EditTreeMenuItemController) {
        super(bindings, folderMenuItemInfo, builder);
    }

    public moveUp(evt: Event) {
        evt.preventDefault();
        evt.stopPropagation();
        var myself = this.folderMenuItemInfo.original;
        var parent = myself.parent;
        var loc = parent.children.indexOf(myself);
        if (loc !== -1) {
            if (loc > 0) {
                var swap = parent.children[loc - 1];
                parent.children[loc - 1] = myself;
                parent.children[loc] = swap;
                this.rebuildParent(parent);
            }
        }
    }

    public moveDown(evt: Event) {
        evt.preventDefault();
        evt.stopPropagation();
        var myself = this.folderMenuItemInfo.original;
        var parent = myself.parent;
        var loc = parent.children.indexOf(myself);
        if (loc !== -1) {
            if (loc + 1 < parent.children.length) {
                var swap = parent.children[loc + 1];
                parent.children[loc + 1] = myself;
                parent.children[loc] = swap;
                this.rebuildParent(parent);
            }
        }
    }

    public moveToParent(evt: Event) {
        evt.preventDefault();
        evt.stopPropagation();
        var myself = this.folderMenuItemInfo.original;
        var parent = myself.parent;
        var superParent = parent.parent;
        if (superParent) {
            var loc = parent.children.indexOf(myself);
            if (loc !== -1) {
                var swap = parent.children[loc];
                parent.children.splice(loc, 1);
                superParent.children.push(swap);
                swap.parent = superParent;
                this.rebuildParent(superParent);
            }
        }
    }

    public moveToChild(evt: Event) {

    }

    public async addItem(evt, menuData, itemData, urlRoot, updateCb) {
        evt.preventDefault();
        evt.stopPropagation();
        try {
            if (TreeMenu.IsFolder(this.folderMenuItemInfo.original)) {
                await this.addItemController.addItem(this.folderMenuItemInfo.original); //This is always going to be a folder node if this function can be called
                this.rebuildParent(this.folderMenuItemInfo.original);
            }
        }
        catch (err) {
            if (err !== AddTreeMenuItemController.CancellationToken) {
                throw err;
            }
        }
    }

    public async editItem(evt: Event) {
        evt.preventDefault();
        evt.stopPropagation();
        try {
            await this.editItemController.edit(this.folderMenuItemInfo.original); //This is always going to be a folder node if this function can be called
            if (this.folderMenuItemInfo.original.parent) {
                this.rebuildParent(this.folderMenuItemInfo.original.parent);
            }
        }
        catch (err) {
            if (err !== AddTreeMenuItemController.CancellationToken) {
                throw err;
            }
        }
    }

    public deleteItem(evt: Event) {

    }
}

interface CreateFolderModel {
    name: string
}

export class AddTreeMenuItemController {
    public static get InjectorArgs(): controller.DiFunction<any>[] {
        return [controller.BindingCollection];
    }

    private static cancellationToken = {}; //Object handle to act as cancellation token
    public static get CancellationToken() {
        return AddTreeMenuItemController.cancellationToken;
    }

    private dialog: controller.OnOffToggle;
    private currentPromise: ExternalPromise<TreeMenu.TreeMenuNode>;
    private questionModel: controller.Model<TreeMenu.TreeMenuNode>;
    private createFolderModel: controller.Model<CreateFolderModel>;
    private currentNode: TreeMenu.TreeMenuFolderNode;
    private toggleGroup: toggles.Group;
    private questionToggle;
    private createFolderToggle;
    private createLinkToggle;
    private createLinkModel;
    private linkAutoTypeModel;
    private autoTypeUrl = true;

    public constructor(private bindings: controller.BindingCollection) {
        this.questionModel = bindings.getModel<TreeMenu.TreeMenuNode>('question');
        this.createFolderModel = bindings.getModel<CreateFolderModel>('createFolder');
        this.createLinkModel = bindings.getModel('createLink');
        this.linkAutoTypeModel = bindings.getModel('linkAutoType');

        this.dialog = bindings.getToggle('dialog');

        this.questionToggle = bindings.getToggle('question');
        this.createFolderToggle = bindings.getToggle('createFolder');
        this.createLinkToggle = bindings.getToggle('createLink');
        this.toggleGroup = new toggles.Group(this.questionToggle, this.createFolderToggle, this.createLinkToggle);

        this.toggleGroup.activate(this.questionToggle);
    }

    public addItem(node: TreeMenu.TreeMenuFolderNode): Promise<TreeMenu.TreeMenuNode> {
        if (this.currentPromise) {
            this.currentPromise.reject(AddTreeMenuItemController.CancellationToken);
        }

        this.currentPromise = new ExternalPromise<TreeMenu.TreeMenuNode>();
        this.currentNode = node;

        this.toggleGroup.activate(this.questionToggle);
        this.questionModel.setData(node);
        this.dialog.on();

        return this.currentPromise.Promise;
    }

    private startFolderCreation(evt) {
        evt.preventDefault();
        evt.stopPropagation();
        this.createFolderModel.clear();

        this.toggleGroup.activate(this.createFolderToggle);
    }

    private createFolder(evt) {
        evt.preventDefault();
        evt.stopPropagation();
        var folderData = this.createFolderModel.getData();
        var newItem: TreeMenu.TreeMenuFolderNode = {
            name: folderData.name,
            children: [],
            parent: this.currentNode,
            currentPage: false,
            expanded: false
        };
        this.finishAdd(newItem);
    }

    private startLinkCreation(evt) {
        evt.preventDefault();
        evt.stopPropagation();
        this.createLinkModel.clear();
        this.linkAutoTypeModel.clear();
        this.autoTypeUrl = true;

        this.toggleGroup.activate(this.createLinkToggle);
    }

    private createLink(evt) {
        evt.preventDefault();
        evt.stopPropagation();

        var linkData = this.createLinkModel.getData();
        var newItem: TreeMenu.TreeMenuLinkNode = {
            name: linkData.name,
            link: linkData.link,
            parent: this.currentNode,
            currentPage: false,
            target: undefined
        };
        this.finishAdd(newItem);
    }

    private finishAdd(newItem) {
        this.currentNode.children.push(newItem);
        this.dialog.off();
        this.currentPromise.resolve(newItem);
        this.currentPromise = null;
    }

    private replaceUrl(x) {
        switch (x) {
            case ' ':
                return '-';
            default:
                return '';
        }
    }

    private nameChanged(evt) {
        if (this.autoTypeUrl) {
            var data = this.createLinkModel.getData();
            var urlName = encodeURI(data.name.replace(/\s|[`~!@#$%^&*()_|+\-=?;:'",.<>\{\}\[\]\\\/]/gi, (x) => this.replaceUrl(x))).toLowerCase();
            this.linkAutoTypeModel.setData({
                link: '/' + urlName
            });
        }
    }

    private cancelAutoType() {
        this.autoTypeUrl = false;
    }
}

export class EditTreeMenuItemController {
    public static get InjectorArgs(): controller.DiFunction<any>[] {
        return [controller.BindingCollection];
    }

    private currentItem: TreeMenu.TreeMenuNode;
    private dialog: controller.OnOffToggle;
    private model: controller.Model<TreeMenu.TreeMenuNode>;
    private linkToggle: controller.OnOffToggle;
    private currentPromise: ExternalPromise<TreeMenu.TreeMenuNode>;

    constructor(bindings: controller.BindingCollection) {
        this.dialog = bindings.getToggle("dialog");
        this.model = bindings.getModel<TreeMenu.TreeMenuNode>("properties");
        this.linkToggle = bindings.getToggle('link');
        this.linkToggle.off();
    }

    public edit(menuItem: TreeMenu.TreeMenuNode): Promise<TreeMenu.TreeMenuNode> {
        if (this.currentPromise) {
            this.currentPromise.reject(AddTreeMenuItemController.CancellationToken);
        }

        this.currentPromise = new ExternalPromise<TreeMenu.TreeMenuNode>();
        this.currentItem = menuItem;

        this.dialog.on();
        this.model.setData(menuItem);
        this.linkToggle.mode = !TreeMenu.IsFolder(menuItem);

        return this.currentPromise.Promise;
    }

    public updateMenuItem(evt) {
        evt.preventDefault();
        evt.stopPropagation();
        this.dialog.off();

        var data = this.model.getData();
        this.currentItem.name = data.name;
        if (!TreeMenu.IsFolder(this.currentItem)) {
            this.currentItem.link = (<TreeMenu.TreeMenuLinkNode>data).link;
        }

        this.currentPromise.resolve(this.currentItem);
        this.currentPromise = null;
    }
}

export function addServices(services: controller.ServiceCollection) {
    services.tryAddShared(Fetcher, s => new CacheBuster(new WindowFetch()));
    services.addTransient(TreeMenu.TreeMenuProvider, TreeMenu.TreeMenuProvider);
    services.addTransient(TreeMenu.TreeMenu, EditTreeMenu);
    services.addTransient(TreeMenu.TreeMenuItem, EditTreeMenuItem);
    services.addShared(AddTreeMenuItemController, AddTreeMenuItemController);
    services.addShared(EditTreeMenuItemController, EditTreeMenuItemController);
}