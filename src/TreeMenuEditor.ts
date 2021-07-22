"use strict";

import * as storage from 'htmlrapier/src/storage';
import * as controller from 'htmlrapier/src/controller';
import * as iter from 'htmlrapier/src/iterable';
import * as TreeMenu from './TreeMenu';
import * as toggles from 'htmlrapier/src/toggles';
import { ExternalPromise } from 'htmlrapier/src/externalpromise';

class Point {
    x: number;
    y: number;
}

/**
 * Get coords from the event in document coords.
 * Adapted from https://www.quirksmode.org/js/events_properties.html#position
 * @param e
 */
function getDocumentCoords(e: MouseEvent): Point {
    var point = new Point();
    if (e.pageX || e.pageY) {
        point.x = e.pageX;
        point.y = e.pageY;
    }
    else if (e.clientX || e.clientY) {
        point.x = e.clientX + document.body.scrollLeft + document.documentElement.scrollLeft;
        point.y = e.clientY + document.body.scrollTop + document.documentElement.scrollTop;
    }
    return point;
}

export class DragDropManager {
    public static get InjectorArgs(): controller.DiFunction<any>[] {
        return [];
    }

    private _currentDrag: EditTreeMenuItem = null;

    constructor() {

    }

    public set currentDrag(value: EditTreeMenuItem) {
        this._currentDrag = value;
    }

    public get currentDrag() {
        return this._currentDrag;
    }

    public clearCurrentDrag(): void {
        this._currentDrag = null;
    }
}

export class EditTreeMenu extends TreeMenu.TreeMenu {
    public static get InjectorArgs(): controller.DiFunction<any>[] {
        return [
            controller.BindingCollection,
            TreeMenu.TreeMenuProvider,
            controller.InjectedControllerBuilder,
            AddTreeMenuItemController,
            DragDropManager];
    }

    public constructor(
        bindings: controller.BindingCollection,
        treeMenuProvider: TreeMenu.TreeMenuProvider,
        builder: controller.InjectedControllerBuilder,
        private addItemController: AddTreeMenuItemController,
        private dragDropManager: DragDropManager) {
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

    public dragOver(evt: DragEvent) {
        evt.preventDefault();
    }

    public drop(evt: DragEvent) {
        evt.preventDefault();
        evt.stopPropagation();
        evt.stopImmediatePropagation();
        alert('Drop ' + this.dragDropManager.currentDrag.node.name + ' onto root');
        this.dragDropManager.clearCurrentDrag();
    }
}

enum DropModes {
    above,
    inside,
    below,
}

class DragDropToggle extends toggles.TypedToggle {
    /**
     * Get the states this toggle can activate.
     */
    public getPossibleStates(): string[] {
        return ['above', 'below', 'inside', 'off'];
    }

    public above(): void {
        return this.applyState('above');
    }

    public below(): void {
        return this.applyState('below');
    }

    public inside(): void {
        return this.applyState('inside');
    }

    public off(): void {
        return this.applyState('off');
    }

    public setDropMode(mode: DropModes) {
        switch (mode) {
            case DropModes.above:
                this.above();
                break;
            case DropModes.inside:
                this.inside();
                break;
            case DropModes.below:
                this.below();
                break;
        }
    }
}

class EditTreeMenuItem extends TreeMenu.TreeMenuItem {
    public static get InjectorArgs(): controller.DiFunction<any>[] {
        return [
            controller.BindingCollection,
            controller.InjectControllerData,
            controller.InjectedControllerBuilder,
            AddTreeMenuItemController,
            EditTreeMenuItemController,
            DeleteTreeMenuItemController,
            ChooseMenuItemController,
            DragDropManager];
    }

    private dragToggle: DragDropToggle;

    public constructor(
        bindings: controller.BindingCollection,
        folderMenuItemInfo: TreeMenu.MenuItemModel,
        builder: controller.InjectedControllerBuilder,
        private addItemController: AddTreeMenuItemController,
        private editItemController: EditTreeMenuItemController,
        private deleteItemController: DeleteTreeMenuItemController,
        private chooseItemController: ChooseMenuItemController,
        private dragDropManager: DragDropManager) {
        super(bindings, folderMenuItemInfo, builder);
        this.dragToggle = bindings.getCustomToggle("drag", new DragDropToggle());
        this.dragToggle.off();
    }

    public dragStart(evt: DragEvent) {
        evt.stopPropagation();
        evt.stopImmediatePropagation();
        this.dragDropManager.currentDrag = this;
    }

    public dragOver(evt: DragEvent) {
        evt.preventDefault();
        evt.stopImmediatePropagation();
        evt.stopPropagation();

        this.dragToggle.setDropMode(this.getDropMode(evt));
    }

    public dragLeave(evt: DragEvent) {
        this.dragToggle.off();
    }

    public drop(evt: DragEvent) {
        var to: TreeMenu.TreeMenuNode;
        var from: TreeMenu.TreeMenuNode;
        var toParent: TreeMenu.TreeMenuNode;
        var fromParent: TreeMenu.TreeMenuNode;
        var loc: number;
        var toLoc: number;
        var dropMode = this.getDropMode(evt);

        evt.preventDefault();
        evt.stopPropagation();
        evt.stopImmediatePropagation();
        this.dragToggle.off();

        //Set this to false anywhere to cancel the drop.
        var safeDrop = true;

        //Clear drag data
        var droppedItem = this.dragDropManager.currentDrag;
        this.dragDropManager.clearCurrentDrag();
        //alert('Drop ' + droppedItem.folderMenuItemInfo.name + ' onto ' + this.folderMenuItemInfo.name);

        //Remove old item
        from = droppedItem.node;
        fromParent = from.parent;
        to = this.folderMenuItemInfo.original;

        if (dropMode == DropModes.inside && TreeMenu.IsFolder(to)) {
            toParent = to;
            toLoc = -1; //Insert last if dropped on folder.
        }
        else {
            toParent = to.parent;
            toLoc = toParent.children.indexOf(to);
        }

        //Make sure we are not trying to move a parent to a child, if so that won't really work.
        var current = toParent;
        while (current) {
            if (current == from) {
                //One of the parents of toParent was the actual item we are moving, cancel drop
                safeDrop = false;
            }
            current = current.parent;
        }

        if (safeDrop) {
            //Remove from old parent
            loc = fromParent.children.indexOf(from);
            if (loc !== -1) {
                fromParent.children.splice(loc, 1);
            }

            //If the parent node is the same recalculate the to location with the removed element
            if (fromParent == toParent) {
                toLoc = toParent.children.indexOf(to);
            }

            //Insert into new parent
            if (toLoc !== -1) {
                if (dropMode === DropModes.below) {
                    ++toLoc;
                }
                toParent.children.splice(toLoc, 0, from);
            }
            else {
                toParent.children.push(from);
            }
            from.parent = toParent;

            //Refresh menu
            droppedItem.rebuildParent(fromParent);
            if (toParent !== fromParent) {
                this.rebuildParent(toParent);
            }
        }
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

    public async moveToChild(evt: Event) {
        evt.preventDefault();
        evt.stopPropagation();
        try {
            var myself = this.folderMenuItemInfo.original;
            var parent = myself.parent;
            var itemIter = new iter.Iterable(parent.children).where(w => w !== myself && TreeMenu.IsFolder(w));
            var nestUnder = await this.chooseItemController.chooseItem("Nest " + myself.name + " under...", itemIter);
            if (TreeMenu.IsFolder(nestUnder)) {
                this.doDelete(myself);
                nestUnder.children.push(myself);
                myself.parent = nestUnder;
                this.rebuildParent(parent);
            }
        }
        catch (err) {
            if (err !== AddTreeMenuItemController.CancellationToken) {
                throw err;
            }
        }
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

    public async deleteItem(evt: Event) {
        evt.preventDefault();
        evt.stopPropagation();
        try {
            var menuItem = this.folderMenuItemInfo.original;
            await this.deleteItemController.confirm(menuItem);
            var parent = menuItem.parent;
            if (this.doDelete(menuItem)) {
                this.rebuildParent(parent);
            }
        }
        catch (err) {
            if (err !== AddTreeMenuItemController.CancellationToken) {
                throw err;
            }
        }
    }

    public get node(): TreeMenu.TreeMenuNode {
        return this.folderMenuItemInfo.original;
    }

    /**
     * Helper function to delete menu item.
     * @param menuItem
     */
    private doDelete(menuItem: TreeMenu.TreeMenuNode) {
        var parent = menuItem.parent;
        var loc = parent.children.indexOf(menuItem);
        if (loc !== -1) {
            menuItem.parent = null;
            parent.children.splice(loc, 1);
            return true;
        }
        return false;
    }

    private getDropMode(evt: DragEvent) {
        var coords = getDocumentCoords(evt);
        var boundRect = (<Element>evt.target).getBoundingClientRect();
        var localY = coords.y - boundRect.top;

        if (TreeMenu.IsFolder(this.folderMenuItemInfo.original)) {
            var third = boundRect.height / 3;
            if (localY < third) {
                return DropModes.above;
            }
            else if (localY < third * 2) {
                return DropModes.inside;
            }
        }
        else {
            var half = boundRect.height / 2;
            if (localY < half) {
                return DropModes.above;
            }
        }

        return DropModes.below;
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
    private currentNodePath: string;
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
        this.currentNodePath = this.getFolderPath(this.currentNode);

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

    private cleanString(s: string): string {
        if (s) {
            return encodeURI(s.replace(/\s|[`~!@#$%^&*()_|+\-=?;:'",.<>\{\}\[\]\\\/]/gi, (x) => this.replaceUrl(x))).toLowerCase();
        }
        return "";
    }

    private replaceUrl(x) {
        switch (x) {
            case ' ':
                return '-';
            default:
                return '';
        }
    }

    private getFolderPath(node: TreeMenu.TreeMenuFolderNode) {
        if (node.parent) {
            return this.getFolderPath(node.parent) + this.cleanString(node.name) + "/";
        }
        return "/";
    }

    public nameChanged(evt: Event): void {
        if (this.autoTypeUrl) {
            var data = this.createLinkModel.getData();
            var urlName = this.currentNodePath + this.cleanString(data.name);
            this.linkAutoTypeModel.setData({
                link: urlName
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

export class DeleteTreeMenuItemController {
    public static get InjectorArgs(): controller.DiFunction<any>[] {
        return [controller.BindingCollection];
    }

    private dialog: controller.OnOffToggle;
    private model: controller.Model<TreeMenu.TreeMenuNode>;
    private currentPromise: ExternalPromise<void>;

    constructor(bindings: controller.BindingCollection) {
        this.dialog = bindings.getToggle('dialog');
        this.model = bindings.getModel<TreeMenu.TreeMenuNode>('info');
    }

    public confirm(menuItem: TreeMenu.TreeMenuNode): Promise<void> {
        if (this.currentPromise) {
            this.currentPromise.reject(AddTreeMenuItemController.CancellationToken);
        }

        this.currentPromise = new ExternalPromise<void>();

        this.model.setData(menuItem);
        this.dialog.on();

        return this.currentPromise.Promise;
    }

    public deleteItem(evt) {
        evt.preventDefault();
        evt.stopPropagation();

        this.currentPromise.resolve();
        this.dialog.off();
    }
}

class MenuItemChoiceController {
    public static get InjectorArgs(): controller.DiFunction<any>[] {
        return [ChooseMenuItemController, controller.InjectControllerData];
    }

    constructor(private chooseMenuController: ChooseMenuItemController, private row) {

    }

    public itemChosen(evt) {
        this.chooseMenuController.chosen(this.row);
    }
}

export class ChooseMenuItemController {
    public static get InjectorArgs(): controller.DiFunction<any>[] {
        return [controller.BindingCollection, controller.InjectedControllerBuilder];
    }

    private dialog: controller.OnOffToggle;
    private promptModel: controller.Model<string>;
    private chooser: controller.Model<TreeMenu.TreeMenuNode>;
    private currentPromise: ExternalPromise<TreeMenu.TreeMenuNode>;

    constructor(bindings: controller.BindingCollection, private builder: controller.InjectedControllerBuilder) {
        this.dialog = bindings.getToggle("dialog");
        this.promptModel = bindings.getModel<string>("prompt");
        this.chooser = bindings.getModel<TreeMenu.TreeMenuNode>("chooser");
    }

    /**
     * Call this function to start choosing a menu item.
     * @param prompt - The propmt to display to the user.
     * @param items - The items that can be chosen from
     */
    public chooseItem(prompt: string, items: TreeMenu.TreeMenuNode[] | iter.IterableInterface<TreeMenu.TreeMenuNode>): Promise<TreeMenu.TreeMenuNode> {
        if (this.currentPromise) {
            this.currentPromise.reject(AddTreeMenuItemController.CancellationToken);
        }

        this.currentPromise = new ExternalPromise<TreeMenu.TreeMenuNode>();

        this.promptModel.setData(prompt);
        this.dialog.on();
        this.chooser.setData(items, this.builder.createOnCallback(MenuItemChoiceController));

        return this.currentPromise.Promise;
    }

    public chosen(item) {
        this.dialog.off();
        this.currentPromise.resolve(item);
        this.currentPromise = null;
    }
}

/**
 * Add the default services for the tree menu in edit mode. Note this will create a default storage for the
 * menu in sesssion storage called defaultTreeMenu. If you only have one tree menu per page
 * this should be fine, otherwise inject your own TreeMenuStorage with a unique name.
 * @param services
 */
export function addServices(services: controller.ServiceCollection) {
    services.tryAddTransient(TreeMenu.TreeMenuStorage, s => new TreeMenu.TreeMenuStorage(new storage.SessionStorageDriver("defaultTreeMenu"))); //Create a default session storage, users are encouraged to make their own
    services.tryAddTransient(TreeMenu.TreeMenuProvider, TreeMenu.TreeMenuProvider);
    services.tryAddTransient(TreeMenu.TreeMenu, EditTreeMenu);
    services.tryAddTransient(TreeMenu.TreeMenuItem, EditTreeMenuItem);
    services.tryAddShared(AddTreeMenuItemController, AddTreeMenuItemController);
    services.tryAddShared(EditTreeMenuItemController, EditTreeMenuItemController);
    services.tryAddShared(DeleteTreeMenuItemController, DeleteTreeMenuItemController);
    services.tryAddShared(ChooseMenuItemController, ChooseMenuItemController);
    services.tryAddTransient(MenuItemChoiceController, MenuItemChoiceController);
    services.tryAddShared(DragDropManager, DragDropManager);
}